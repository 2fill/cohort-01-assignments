#!/bin/bash
# APP 시작 템플릿 사용자 데이터
# 아래 '본인-...' 다섯 값을 본인 환경 값으로 바꿔서 시작 템플릿에 붙여 넣는다.
#   - DB_HOST 에는 포트, http:// 를 넣지 않는다.
#   - DB_SECRET_ID 에는 '!' 가 들어갈 수 있으니 작은따옴표를 지우지 않는다.
#   - REDIS_URL 은 rediss:// (s 두 개) 로 시작하고 포트 6379 를 한 번만 쓴다.
set -euo pipefail

BUCKET='본인-버킷-이름'
DB_HOST='본인-RDS-엔드포인트'
DB_SECRET_ID='본인-RDS-마스터-자격-증명-ARN'
SESSION_SECRET_ID='fill-asbg/session-secret'
REDIS_URL='rediss://본인-캐시-엔드포인트:6379'

dnf install -y nodejs24
# AL2023은 처음 설치한 Node 버전을 /usr/bin/node 로 연결한다. 혹시 없으면 직접 연결한다.
[ -x /usr/bin/node ] || ln -sf /usr/bin/node-24 /usr/bin/node

mkdir -p /srv/portal
aws s3 cp "s3://$BUCKET/app.tar.gz" /tmp/app.tar.gz --region ap-northeast-2
tar -xzf /tmp/app.tar.gz -C /srv/portal --no-same-owner

cat > /etc/portal-app.env <<ENV
AWS_REGION=ap-northeast-2
DB_HOST=$DB_HOST
DB_SECRET_ID=$DB_SECRET_ID
SESSION_SECRET_ID=$SESSION_SECRET_ID
REDIS_URL=$REDIS_URL
ENV
chmod 600 /etc/portal-app.env

cp /srv/portal/app/portal-app.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now portal-app
