# С Мунай — лендинг и сервис заявок

Два компонента в одном репозитории.

## `lead-service/` — мини-CRM для отдела продаж

Приём заявок с сайта и работа с ними: статусы, ответственные, доска, аналитика, выгрузка CSV,
уведомления в Telegram. Node.js 22+, база — файл SQLite, внешних зависимостей нет.

```bash
cd lead-service
cp .env.example .env
npm start
```

Панель откроется на <http://localhost:4000>. Подробности — в [lead-service/README.md](lead-service/README.md).

## `procure-service/` — ИИ-мастер по закупке товара

Отдельный сервис: по названию/ссылке/описанию товара ИИ-агент (Claude + веб-поиск) собирает
характеристики, находит и сравнивает поставщиков, анализирует цену и отмечает риски.
Node.js 22+, база — файл SQLite, внешних зависимостей нет.

```bash
cd procure-service
cp .env.example .env
# впишите ANTHROPIC_API_KEY
npm start
```

Панель откроется на <http://localhost:4100>. Подробности — в
[procure-service/README.md](procure-service/README.md).

## Корень репозитория — статический лендинг

`index.html`, `css/`, `js/`, `assets/`. Форма заявки подключена к сервису через блок
`window.LEADS_CONFIG` в конце `index.html`: укажите адрес сервиса и публичный ключ сайта
из раздела «Подключение сайта». Пустые значения — форма работает в демо-режиме без отправки.

Локальный просмотр лендинга:

```bash
node .claude/static-server.js
```

## Что не входит в репозиторий

- `lead-service/.env` и `lead-service/data/` — локальные настройки и база заявок;
- `procure-service/.env` и `procure-service/data/` — локальные настройки и база отчётов;
- `smunai-digital-drive/` — отдельный проект со своим репозиторием;
- `_preview.html` — служебный файл предпросмотра.
