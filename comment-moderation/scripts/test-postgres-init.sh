#!/bin/sh
set -eu
umask 077
tr -d '-' </proc/sys/kernel/random/uuid >/tmp/moderation-test-password
export POSTGRES_PASSWORD="$(cat /tmp/moderation-test-password)"
exec docker-entrypoint.sh postgres
