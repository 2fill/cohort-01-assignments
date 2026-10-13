#!/usr/bin/env bash
# 배포 파일 두 개를 만든다.
#   dist/app.tar.gz  → APP 서버 (최상위 폴더 app/)
#   dist/web.tar.gz  → WEB 서버 (최상위 폴더 web/)
# 사용자 데이터가 /srv/portal 에 풀기 때문에 최상위 폴더 이름이 중요하다.
set -euo pipefail

cd "$(dirname "$0")"

command -v node >/dev/null || { echo "node 가 필요합니다 (22 이상)"; exit 1; }
command -v npm >/dev/null || { echo "npm 이 필요합니다"; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22 이상이 필요합니다 (현재 $(node --version))"
  exit 1
fi

# macOS tar가 ._파일 같은 메타데이터를 넣지 않도록 한다.
export COPYFILE_DISABLE=1
TAR_OPTS=()
if tar --version 2>/dev/null | grep -q bsdtar \
  && tar --no-mac-metadata --no-xattrs -cf /dev/null -T /dev/null 2>/dev/null; then
  TAR_OPTS=(--no-mac-metadata --no-xattrs)
fi

rm -rf build dist
mkdir -p build dist

echo "▶ APP 패키징"
mkdir -p build/app
cp app/package.json app/package-lock.json app/server.js app/portal-app.service build/app/
(cd build/app && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
tar ${TAR_OPTS[@]+"${TAR_OPTS[@]}"} -czf dist/app.tar.gz -C build app

echo "▶ WEB 패키징"
mkdir -p build/web
cp web/nginx.conf build/web/
cp -R web/html build/web/html
tar ${TAR_OPTS[@]+"${TAR_OPTS[@]}"} -czf dist/web.tar.gz -C build web

echo
echo "완료"
ls -lh dist/
echo
echo "app.tar.gz 확인:"
tar -tzf dist/app.tar.gz | grep -E '^app/(server\.js|portal-app\.service|package\.json)$'
echo "web.tar.gz 확인:"
tar -tzf dist/web.tar.gz | grep -E '^web/(nginx\.conf|html/index\.html)$'
