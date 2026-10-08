#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR"

# Публичные домены (SAN DNS). Задаются вторым аргументом (можно несколько
# через запятую/пробел) или переменной окружения PUBLIC_DOMAINS.
# Пример: ./generate-cert.sh 147.45.125.8 "opensclaw.ai,www.opensclaw.ai"
PUBLIC_DOMAINS="${2:-${PUBLIC_DOMAINS:-}}"

if [ -n "$PUBLIC_DOMAINS" ]; then
  # Нормализуем разделители: запятые -> пробелы
  DOMAIN_LIST=$(printf '%s' "$PUBLIC_DOMAINS" | tr ',' ' ')
else
  echo "Внимание: домен(ы) не заданы. Передайте второй аргумент (или PUBLIC_DOMAINS), иначе SAN не будет содержать DNS-имя для браузера."
  DOMAIN_LIST=""
fi

# Определение всех IP адресов хоста
DETECTED_IPS=()
DETECTED_IPS+=("127.0.0.1")

if [ -n "$1" ]; then
  DETECTED_IPS+=("$1")
fi
if [ -n "$HOST_IP" ]; then
  DETECTED_IPS+=("$HOST_IP")
fi
if [ -n "$SERVER_IP" ]; then
  DETECTED_IPS+=("$SERVER_IP")
fi

if command -v hostname >/dev/null 2>&1; then
  for ip in $(hostname -I 2>/dev/null); do
    DETECTED_IPS+=("$ip")
  done
fi

EXT_IP=$(curl -s --connect-timeout 2 https://api.ipify.org 2>/dev/null || curl -s --connect-timeout 2 https://ifconfig.me 2>/dev/null || true)
if [ -n "$EXT_IP" ]; then
  DETECTED_IPS+=("$EXT_IP")
fi

DETECTED_IPS+=("147.45.125.8")

# Удаляем дубликаты
UNIQUE_IPS=($(printf "%s\n" "${DETECTED_IPS[@]}" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u))

PRIMARY_IP="147.45.125.8"
for ip in "${UNIQUE_IPS[@]}"; do
  if [ "$ip" != "127.0.0.1" ]; then
    PRIMARY_IP="$ip"
    break
  fi
done

# Если заданы домены, используем первый домен как CN (для читаемости);
# иначе — основной IP. Браузеры проверяют только SAN, CN для совместимости.
PRIMARY_CN="$PRIMARY_IP"
if [ -n "$DOMAIN_LIST" ]; then
  PRIMARY_CN=$(printf '%s\n' $DOMAIN_LIST | head -n1)
fi

echo "=== Генерация TLS-сертификата ==="
echo "Primary CN: $PRIMARY_CN"
echo "SAN IPs:  ${UNIQUE_IPS[*]}"
echo "SAN DNS:  $DOMAIN_LIST"

cat << EOF > "$DIR/openssl.cnf"
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = $PRIMARY_IP

[v3_req]
keyUsage = keyEncipherment, dataEncipherment, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
EOF

DNS_IDX=2
for d in $DOMAIN_LIST; do
  [ -z "$d" ] && continue
  echo "DNS.$DNS_IDX = $d" >> "$DIR/openssl.cnf"
  DNS_IDX=$((DNS_IDX + 1))
done

IP_IDX=1
for ip in "${UNIQUE_IPS[@]}"; do
  echo "IP.$IP_IDX = $ip" >> "$DIR/openssl.cnf"
  IP_IDX=$((IP_IDX + 1))
done

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -config "$DIR/openssl.cnf" \
  -keyout "$DIR/privkey.pem" \
  -out "$DIR/fullchain.pem"

echo "TLS-сертификат готов: $DIR/fullchain.pem"
