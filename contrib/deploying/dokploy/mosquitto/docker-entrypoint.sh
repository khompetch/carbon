#!/bin/sh
# Writes the broker's password file and ACL from the environment, then starts
# Mosquitto. Runs on every start, so a changed password needs only a redeploy.
set -eu

: "${MQTT_INGEST_PASSWORD:?Set MQTT_INGEST_PASSWORD (see .env.example)}"
: "${MQTT_GATEWAY_PASSWORD:?Set MQTT_GATEWAY_PASSWORD (see .env.example)}"

# Mosquitto 2.0.18+ warns on (and later versions refuse) a world-readable
# password or ACL file, so create both private from the start.
umask 077
dir=/mosquitto/generated
mkdir -p "$dir"
rm -f "$dir/passwd"
touch "$dir/passwd"
mosquitto_passwd -b "$dir/passwd" pulse-ingest "$MQTT_INGEST_PASSWORD"
mosquitto_passwd -b "$dir/passwd" pulse-gateway "$MQTT_GATEWAY_PASSWORD"
cp /etc/mosquitto-carbon/acl "$dir/acl"

chown -R mosquitto:mosquitto "$dir"

exec /usr/sbin/mosquitto -c /etc/mosquitto-carbon/mosquitto.conf
