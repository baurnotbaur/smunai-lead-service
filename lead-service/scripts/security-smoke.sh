#!/usr/bin/env bash
# Security smoke-test для lead-service.
# Гонять ТОЛЬКО на staging/preview с одноразовой базой, не на проде.
#
# Использование (Git Bash / WSL / любой bash):
#   BASE=https://<preview>.vercel.app \
#   MGR_EMAIL=manager@x.kz MGR_PASS=... \
#   ADMIN_EMAIL=admin@x.kz ADMIN_PASS=... \
#   SITE_KEY=<public_key нужного сайта> \
#   bash scripts/security-smoke.sh
#
# Авторизованные проверки (IDOR/роли/экспорт) пропускаются, если не заданы
# MGR_EMAIL/MGR_PASS. Заведи на staging рядового менеджера и (опц.) админа.

set -u
BASE="${BASE:-http://localhost:4000}"
ORIGIN="$BASE"
PASS=0; FAIL=0; SKIP=0
JAR_M="$(mktemp)"; JAR_A="$(mktemp)"
trap 'rm -f "$JAR_M" "$JAR_A"' EXIT

ok(){ echo "  ✅ PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "  ❌ FAIL: $1"; FAIL=$((FAIL+1)); }
sk(){ echo "  ⏭️  SKIP: $1"; SKIP=$((SKIP+1)); }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "=== target: $BASE ==="

# 1. Дефолтный админ не должен пускать -----------------------------------------
c=$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
      -H "Origin: $ORIGIN" -d '{"email":"admin@local","password":"admin12345"}')
[ "$c" = "200" ] && no "дефолт admin@local/admin12345 ПУСКАЕТ (200)" \
                 || ok "дефолтный админ не пускает (HTTP $c)"

# 2. Неаутентифицированный доступ к API → 401 ----------------------------------
for e in /api/leads /api/users /api/stats /api/companies /api/leads/export.csv; do
  c=$(code "$BASE$e")
  [ "$c" = "401" ] && ok "unauth $e → 401" || no "unauth $e → $c (ждали 401)"
done

# 3. Rate-limit логина + попытка обхода через X-Forwarded-For ------------------
echo "  … 8 неверных логинов подряд (лимит 5/15мин)"
got429=0
for i in $(seq 1 8); do
  c=$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
        -H "Origin: $ORIGIN" -d '{"email":"nobody@example.com","password":"x"}')
  [ "$c" = "429" ] && got429=1
done
[ "$got429" = "1" ] && ok "rate-limit логина срабатывает (429)" \
                    || no "rate-limit логина НЕ сработал за 8 попыток"

echo "  … те же попытки, но с подделкой X-Forwarded-For (не должно обходить)"
bypass=0
for i in $(seq 1 8); do
  c=$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
        -H "Origin: $ORIGIN" -H "X-Forwarded-For: 1.2.3.$i" \
        -d '{"email":"nobody@example.com","password":"x"}')
  [ "$c" != "429" ] && bypass=$((bypass+1))
done
# если спуф обходит лимит — почти все пройдут не-429
[ "$bypass" -ge 6 ] && no "X-Forwarded-For ОБХОДИТ rate-limit ($bypass/8 прошли)" \
                    || ok "подделка X-Forwarded-For не обходит лимит"

# 4. Перечисление email по времени/ответу на сбросе ---------------------------
b1=$(curl -s -X POST "$BASE/api/auth/reset-password" -H 'Content-Type: application/json' \
       -H "Origin: $ORIGIN" -d "{\"email\":\"${MGR_EMAIL:-real@example.com}\"}")
b2=$(curl -s -X POST "$BASE/api/auth/reset-password" -H 'Content-Type: application/json' \
       -H "Origin: $ORIGIN" -d '{"email":"definitely-not-here@example.com"}')
[ "$b1" = "$b2" ] && ok "ответ сброса одинаков для существующего/несуществующего email" \
                  || no "ответ сброса РАЗЛИЧАЕТСЯ → перечисление аккаунтов ($b1 | $b2)"

# 5. Кросс-доменный POST (CSRF) должен блокироваться ---------------------------
c=$(code -X POST "$BASE/api/leads" -H 'Content-Type: application/json' \
      -H "Origin: https://evil.example" -d '{}')
[ "$c" = "403" ] || [ "$c" = "401" ] && ok "кросс-origin мутация отбита (HTTP $c)" \
                                     || no "кросс-origin POST прошёл (HTTP $c, ждали 403/401)"

# 6. Обход пути в статике ------------------------------------------------------
for p in '/..%2f..%2f..%2fetc%2fpasswd' '/%2e%2e/%2e%2e/package.json'; do
  c=$(code "$BASE$p")
  [ "$c" = "403" ] || [ "$c" = "404" ] && ok "path-traversal $p → $c" \
                                       || no "path-traversal $p → $c (ждали 403/404)"
done

# 7. Публичная форма: honeypot + rate-limit ------------------------------------
if [ -n "${SITE_KEY:-}" ]; then
  # honeypot заполнен → 200, но лид фиктивный
  c=$(code -X POST "$BASE/api/v1/leads" -H 'Content-Type: application/json' \
        -d "{\"key\":\"$SITE_KEY\",\"phone\":\"+77010000000\",\"_hp\":\"bot\"}")
  [ "$c" = "200" ] && ok "honeypot принимает и глушит бота (200, лид не создаётся)" \
                   || no "honeypot: HTTP $c (ждали 200)"
  echo "  … 12 заявок/мин с формы (лимит 10/60мин)"
  got=0
  for i in $(seq 1 12); do
    c=$(code -X POST "$BASE/api/v1/leads" -H 'Content-Type: application/json' \
          -d "{\"key\":\"$SITE_KEY\",\"phone\":\"+7701000$i\"}")
    [ "$c" = "429" ] && got=1
  done
  [ "$got" = "1" ] && ok "rate-limit публичной формы срабатывает (429)" \
                   || no "rate-limit формы НЕ сработал"
else
  sk "публичная форма (SITE_KEY не задан)"
fi

# --- авторизованные проверки --------------------------------------------------
if [ -n "${MGR_EMAIL:-}" ] && [ -n "${MGR_PASS:-}" ]; then
  lc=$(code -c "$JAR_M" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
         -H "Origin: $ORIGIN" -d "{\"email\":\"$MGR_EMAIL\",\"password\":\"$MGR_PASS\"}")
  if [ "$lc" != "200" ]; then
    no "логин менеджера не удался (HTTP $lc) — авторизованные тесты пропущены"
  else
    ok "менеджер залогинен"

    # 8. Менеджер не может назначить себе роль admin (эскалация)
    me=$(curl -s -b "$JAR_M" "$BASE/api/me")
    uid=$(echo "$me" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
    if [ -n "$uid" ]; then
      curl -s -b "$JAR_M" -X PATCH "$BASE/api/users/$uid" -H 'Content-Type: application/json' \
        -H "Origin: $ORIGIN" -d '{"role":"admin"}' >/dev/null
      role=$(curl -s -b "$JAR_M" "$BASE/api/me" | grep -oE '"role":"[a-z_]+"' | head -1)
      echo "$role" | grep -q admin && no "ЭСКАЛАЦИЯ: менеджер стал admin ($role)" \
                                   || ok "эскалация роли заблокирована ($role)"
    else
      sk "эскалация роли (не удалось получить id менеджера)"
    fi

    # 9. Менеджер не выгружает базу без согласия (all=1 — только админ)
    #    берём id первого сегмента, если есть
    seg=$(curl -s -b "$JAR_M" "$BASE/api/segments" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
    if [ -n "${seg:-}" ]; then
      hAll=$(curl -s -b "$JAR_M" -o /dev/null -w '%{http_code}' \
               "$BASE/api/segments/$seg/audience.csv?all=1")
      # менеджеру all=1 либо запрещён (403), либо молча деградирует до consent-only.
      # жёсткая проверка: сравниваем размер выгрузки all=1 и обычной
      nAll=$(curl -s -b "$JAR_M" "$BASE/api/segments/$seg/audience.csv?all=1" | wc -l)
      nDef=$(curl -s -b "$JAR_M" "$BASE/api/segments/$seg/audience.csv" | wc -l)
      [ "$nAll" -le "$nDef" ] && ok "менеджеру all=1 не даёт больше строк (consent-only держится)" \
                             || no "менеджер выгрузил больше по all=1 ($nAll > $nDef строк) — обход согласия"
    else
      sk "экспорт аудитории (нет сегментов на staging)"
    fi

    # 10. /api/users не отдаёт email рядовому менеджеру
    ub=$(curl -s -b "$JAR_M" "$BASE/api/users")
    echo "$ub" | grep -q '"email"' && no "/api/users отдаёт email менеджеру (реестр сотрудников течёт)" \
                                   || ok "/api/users менеджеру без email"
  fi
else
  sk "авторизованные тесты (MGR_EMAIL/MGR_PASS не заданы)"
fi

echo
echo "=== ИТОГ: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP ==="
[ "$FAIL" -eq 0 ]
