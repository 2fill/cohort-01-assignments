#!/bin/bash
# WEB 시작 템플릿 사용자 데이터
# 아래 '본인-...' 두 값을 본인 환경 값으로 바꿔서 시작 템플릿에 붙여 넣는다.
#   - APP_ALB 에는 http://, 끝의 /, 포트를 넣지 않는다. (internal- 로 시작하는 DNS 이름만)
set -euo pipefail

BUCKET='본인-버킷-이름'
APP_ALB='본인-Internal-ALB-DNS'

dnf install -y nginx
mkdir -p /srv/portal
aws s3 cp "s3://$BUCKET/web.tar.gz" /tmp/web.tar.gz --region ap-northeast-2
tar -xzf /tmp/web.tar.gz -C /srv/portal --no-same-owner

# IMDSv2로 이 인스턴스의 ID와 AZ를 읽어 응답 헤더(X-Web-Instance)에 넣는다.
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
meta() { curl -sH "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }
WEB_INSTANCE="$(meta instance-id) $(meta placement/availability-zone)"

sed -e "s|__APP_ALB__|$APP_ALB|" -e "s|__WEB_INSTANCE__|$WEB_INSTANCE|" \
  /srv/portal/web/nginx.conf > /etc/nginx/nginx.conf
nginx -t
systemctl enable --now nginx
