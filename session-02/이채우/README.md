# Session 02 "수강신청 서비스 AWS 구축 및 검증" 공부 기록

```text
source/
├── pack.sh                  배포 파일 2개 생성 (dist/app.tar.gz, dist/web.tar.gz)
├── app/                     APP (Node.js, 포트 8080)
│   ├── server.js
│   ├── package.json / package-lock.json
│   └── portal-app.service   systemd 서비스 (DynamicUser + HOME 설정 포함)
├── web/                     WEB (Nginx)
│   ├── nginx.conf           __APP_ALB__, __WEB_INSTANCE__
│   └── html/                index.html, app.js, style.css
├── userdata/                시작 템플릿에 붙여 넣을 스크립트 (app.sh, web.sh)
├── policies/                EC2 역할 인라인 정책 (role-app.json, role-web.json)
└── scripts/watch.mjs        관찰 스크립트
```


## APP 환경 변수

| 변수 | 내용 |
|---|---|
| `DB_HOST` | RDS 엔드포인트 |
| `DB_SECRET_ID` | RDS 마스터 자격 증명 ARN |
| `SESSION_SECRET_ID` | 세션 서명 키 보안 암호 이름 (`fill-asbg/session-secret`) |
| `REDIS_URL` | `rediss://캐시-엔드포인트:6379` |
| `AWS_REGION` | `ap-northeast-2` |

## API

| 경로 | 설명 |
|---|---|
| `GET /health` | ALB 상태 검사 |
| `POST /api/login` | 로그인, 세션을 Valkey에 저장 |
| `POST /api/logout` | 로그아웃 |
| `GET /api/me` | 로그인 사용자와 처리한 APP 인스턴스·AZ |
| `GET /api/courses` | 강좌 목록 (로그인 없이 조회, 부하 시험용) |
| `GET /api/enrollments` | 내 신청 내역 |
| `POST /api/enrollments` | 수강신청 `{ "courseId": 1 }` |
| `DELETE /api/enrollments/:courseId` | 신청 취소 |

모든 응답에 `X-App-Instance` 헤더가, WEB을 거친 응답에는 `X-Web-Instance` 헤더가 붙는다.

테스트 계정: `test01` ~ `test30`, 비밀번호 `asbg1234` (처음 시작한 APP이 DB와 함께 생성)
## 1. VPC 생성

| 설정 | 의미 |
|---|---|
| DNS 확인 활성화 (이름을 찾을 수 있게) | VPC 안에서 AWS가 제공하는 DNS 서버를 쓸 수 있음 |
| DNS 호스트 이름 활성화 (이름을 가질 수 있게) | EC2 같은 리소스에 DNS 이름을 자동으로 붙여줌 |

## 2. 서브넷 생성

퍼블릭 IPv4 자동 할당 비활성화

→ EC2를 띄울 때 공인 IP를 붙일지 설정

→ app-a/c: 들어오는 요청은 ALB, 나가는 통신은 NAT로 처리해서 필요 없음

| 서브넷 | 용도 |
|---|---|
| `public-a` | Public ALB, NAT |
| `public-c` | Public ALB |
| `app-a/c` | WEB EC2, APP EC2, Internal ALB |
| `data-a/c` | RDS, Valkey |

## 3. 인터넷 게이트웨이 생성 및 VPC에 연결

`fill-asbg-igw`

## 4. NAT Gateway 생성

`fill-asbgnat-a`

| 유형 | 설명 |
|---|---|
| 영역별 (선택) | 출구를 서브넷 하나에만 만들기 |
| ~~리전별~~ | ~~출구를 VPC 전체에 하나 만들기~~ |

## 5. 라우팅 테이블 생성 및 서브넷 연결

| 라우팅 테이블 | 연결 | 의미 |
|---|---|---|
| `fill-asbg-rt-public` | 인터넷 게이트웨이 | 양방향 통신 |
| `fill-asbg-rt-app` | NAT 게이트웨이 | 나가는 것만 허용 |
| `fill-asbg-rt-data` | 없음 | - |

## 6. 엔드포인트 생성

EC2가 부팅하면서 S3에 있는 파일을 내려받음

→ 이때 S3 주소로 가는 건 엔드포인트로 보내라!

`fill-asbg-vpce-s3`

| 구분 | 경로 |
|---|---|
| 엔드포인트가 없으면 | APP 서버 → NAT → 인터넷 → S3 |
| 엔드포인트가 있으면 | APP 서버 → S3 |

## 7. 보안 그룹 생성

| 대상 | 접근 | 보안 그룹 | 인바운드 | 소스 |
|---|---|---|---|---|
| Public ALB | 아무나 접근 가능 | `fill-asbg-sg-alb-public` | HTTP | 0.0.0.0/0 |
| WEB | Public ALB만 접근 가능 | `fill-asbg-sg-web` | HTTP | `fill-asbg-sg-alb-public` |
| Internal ALB | WEB만 접근 가능 | `fill-asbg-sg-alb-internal` | HTTP | `fill-asbg-sg-web` |
| APP | Internal ALB만 접근 가능 | `fill-asbg-sg-app` | 사용자 지정 TCP 8080 | `fill-asbg-sg-alb-internal` |
| DB | APP만 접근 가능 | `fill-asbg-sg-db` | MYSQL/Aurora TCP 3306 | `fill-asbg-sg-app` |
| 캐시 | APP만 접근 가능 | `fill-asbg-sg-cache` | 사용자 지정 TCP 6379-6380 | `fill-asbg-sg-app` |

## 8. DB 서브넷 그룹 생성

RDS에게 서브넷 그룹 단위로 DB를 만들 수 있도록 도와줌

- 2개 생성 → 본 DB + 예비 DB
- data 서브넷

## 9. ElastiCache - Valkey 캐시 생성

로그인 세션을 모든 APP 서버가 공유 → 서버가 바뀌어도 로그인 유지

**Valkey + Serverless**

- Redis와 같은 방식으로 쓰는 저장소
- 서버 크기 고를 필요 없이, AWS가 알아서 확장
- 가장 안전한 `data-a`, `data-c` 두 AZ에 걸쳐둠

**보안**

| 항목 | 설정 |
|---|---|
| 보안 그룹 | `sg-cache`만 → APP 서버만 접근 가능 |
| 액세스 제어 | 없음 (비밀번호 대신 VPC + `sg-cache`) |

```text
rediss://fill-asbg-cache-kvwisl.serverless.apn2.cache.amazonaws.com:6379
```

## 10. 애플리케이션 배포 준비

**소스 코드 패키징**

APP은 `app.tar.gz`, WEB은 `web.tar.gz`로 묶어서 서버가 내려받기 쉽게 만듦

서버 새로 띄울 때마다 같은 파일을 받음

**S3 버킷에 업로드** ~~(USB 느낌…)~~

- 버킷 최상위에 `app.tar.gz`, `web.tar.gz` 저장
- 서버가 시작할 때 여기서 코드를 가져감
- 보안: IAM 역할을 가진 서버만

**세션 서명 키 만들기 (Secrets Manager)**

`fill-asbg/session-secret`

- 로그인 쿠키 만들 때 쓰는 비밀 키
- 모든 APP 서버가 같은 키를 읽음

## 11. IAM 역할 생성

`AmazonSSMManagedInstanceCore` → 키 없이 콘솔로 서버 접속

| 역할 | 인라인 정책 |
|---|---|
| `fill-asbg-rold-web` | S3의 `web.tar.gz` 읽기만 허용 |
| `fill-asbg-role-app` | S3의 `app.tar.gz` 읽기, Secrets Manager 2개(RDS 비밀번호, 세션 키) 읽기 |

## 12. 로드 밸런서와 대상 그룹 설정

사용자 → Public ALB → WEB(Nginx) → Internal ALB → APP(Node) → RDS / Valkey

| 구분 | 대상 그룹 | 로드 밸런서 |
|---|---|---|
| WEB (외부) | `fill-asbg-tg-web` (포트 80, 상태 검사 `/health`) | Public ALB (`fill-asbg-alb-public`): public 서브넷 2개 AZ, `sg-alb-public`, HTTP → WEB |
| APP (내부) | `fill-asbg-tg-app` (포트 8080, 상태 검사 `/health`) | Internal ALB (`fill-asbg-alb-internal`): app 서브넷 2개 AZ, `sg-alb-internal`, HTTP 80 → APP |

## 13. 시작 템플릿 생성

서버가 늘거나 교체될 때마다 같은 설정으로 시작

| 항목 | `fill-asbg-lt-app` | `fill-asbg-lt-web` |
|---|---|---|
| AMI | Amazon Linux 2023 | Amazon Linux 2023 |
| 유형 | t3.micro | t3.micro |
| 보안 그룹 | `sg-app` | `sg-web` |
| IAM 프로파일 | `fill-asbg-role-app` | `fill-asbg-rold-web` |
| 사용자 데이터 | `app.sh` | `web.sh` |

## 14. Auto Scaling 그룹 생성

서버 수 자동 맞춤 (죽으면 새로 만들고, 바쁘면 늘림)

| 크기 조정 정책 (APP) | 설명 |
|---|---|
| 평균 CPU 사용률 50% 유지 | 넘으면 서버 늘림 |

## 15. 테스트

서비스 관찰 스크립트

```bash
node scripts/watch.mjs http://fill-asbg-alb-public-718249319.ap-northeast-2.elb.amazonaws.com
```

### A. APP 서버 1대 종료 (세션 공유 + 장애 복구)

**결과**

- EC2에서 APP 서버 하나 지움 → 504 뜨면서 로그인 풀림 → 수강신청 화면 돌아옴
- 401 안 뜸 → 서버 바뀌어도 쿠키 안정, 세션이 Valkey에 공유
### B. WEB 서버 1대 종료

### C. 부하 (서버 자동 증가)

부하 생성 명령어

```bash
hey -z 5m -c 100 http://fill-asbg-alb-public-718249319.ap-northeast-2.elb.amazonaws.com/api/courses
```

## 16. 다 지우기

Auto Scaling 그룹 → 로드 밸런서 → 대상 그룹 → 시작 템플릿 → 데이터베이스 → Valkey 캐시 → NAT 게이트웨이 → 탄력적 IP → 엔드포인트 → VPC → S3 → Secrets Manager → IAM 역할