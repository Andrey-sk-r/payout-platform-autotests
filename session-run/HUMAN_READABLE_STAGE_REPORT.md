# Отчёт о регрессионном прогоне Payout Platform

Дата прогона: 30 июля 2026  
Окружение: Stage — `https://payout.preprod.olympusmobile.co.za`  
Браузер: Chromium  
Режим: один worker, одна переиспользуемая сессия авторизации  
Исключения: тесты Employee Cards не запускались по запросу  
Длительность: 5 минут 54 секунды

## Итог

В прогон вошло 177 продуктовых тестов. Дополнительно Playwright выполнил один технический setup-тест, который создал общую авторизованную сессию.

| Результат | Количество |
|---|---:|
| Успешно пройдено продуктовых тестов | 159 |
| Упало | 7 |
| Пропущено по условию теста | 1 |
| Не запустилось из-за падения предыдущего serial-теста | 10 |
| Технический setup общей сессии | 1, успешно |

Авторизация в общей сессии работала стабильно. Падений на login OTP, переходе к OTP-странице или вводе OTP в этом прогоне не было.

## Что упало

### 1. Batch line view — открытие draft batch

Сценарий: `opens line view inside draft batch`

Тест нажал первую доступную кнопку `Open` на странице Payouts, но URL остался `/payouts` вместо перехода в карточку batch.

Предварительная классификация: требует проверки. Возможны два варианта:

- кнопка в текущем UI больше не должна открывать отдельный URL;
- кнопка видна, но переход действительно не срабатывает.

Следующее действие: вручную проверить первую кнопку `Open` и уточнить ожидаемый маршрут.

### 2. Batch state pages — подготовка состояний batch

Сценарий: `shows draft batch entry actions and empty-batch guard`

Подготовительный шаг запросил бизнес-OTP для подтверждения batch. Stage вернул `wait_timeout`: уже существовал SMS OTP, до следующего запроса оставалось 2 минуты 33 секунды.

Это не проблема OTP авторизации. Это отдельный OTP бизнес-операции approve batch.

Предварительная классификация: ограничение окружения и недостаточная обработка cooldown в тесте.

Следующее действие: добавить ожидание `wait_timeout` для `/batch/otp/request` либо переиспользовать ещё действующий код.

### 3. Beneficiaries — добавление PayShap destination

Сценарий: `BEN-UI-004: add PayShap destination and reject pending changes from Review modal`

После успешного создания PayShap destination тест попытался закрыть окно. Локатор `Close` нашёл одновременно две кнопки: крестик в заголовке и кнопку `Close` внизу.

Предварительная классификация: дефект автотеста.

Следующее действие: выбирать конкретную кнопку, например кнопку в footer или `getByLabel('Close', { exact: true })`.

### 4. History — фильтр по beneficiary и диапазону дат

Сценарий: `filters completed/approved history batches by beneficiary and inclusive range`

Тест ожидал две записи для `Green Valley Farms` за 27–29 мая 2026 года. UI показал empty state: `No history batches found`.

Предварительная классификация: тестовые данные не соответствуют ожиданиям либо фильтрация на Stage работает иначе.

Следующее действие: проверить наличие ожидаемых batch в Stage и фактические значения поля Updated date.

### 5. Settings Team — повторная отправка приглашения

Сценарий: `TEAM-UI-002: invite user creates pending row and supports re-invite`

Пользователь был создан, pending-строка появилась. На шаге Re-Invite тест нашёл три одинаковые кнопки в разных строках и не смог выбрать нужную.

Предварительная классификация: дефект автотеста.

Следующее действие: искать `Re-Invite` только внутри строки созданного пользователя.

### 6. Provider Credentials — проверка фильтров

Сценарий: `PC-LIST-002: get-list filters by provider_code, name, client_id, and is_active`

Для проверки фильтров тест сначала создаёт временный provider credential. Stage отклонил создание: допустим только `provider_code=simplepay`, а тест выбрал другое значение из существующих данных.

Предварительная классификация: тест не соответствует текущему API-контракту Stage.

Следующее действие: использовать `simplepay` либо получать перечень допустимых provider codes из контракта, а не из существующих записей.

### 7. Provider Credentials — полный CRUD

Сценарий: `PC-CRUD-001: create, get, update, update-active, update-apikey, and delete disposable provider credential`

Сценарий остановился на создании временного credential по той же причине: Stage принимает только `provider_code=simplepay`.

Предварительная классификация: тест не соответствует текущему API-контракту Stage.

Следующее действие: исправить provider code, затем повторить полный CRUD.

## Что не запустилось

Следующие 10 тестов не имеют собственного результата. Они находятся в serial-наборах и были автоматически остановлены после падения предыдущего сценария.

### Зависели от Batch line view

1. `opens line view inside batch approval review`
2. `opens line view inside historical batch`

### Зависели от Batch state pages

3. `shows submitted approval actions`
4. `shows returned edit actions and reason`
5. `shows cancelled and scheduled batches in History`

### Зависел от Beneficiaries BEN-UI-004

6. `BEN-UI-005: destination actions menu is available from details`

### Зависели от первого History-теста

7. `shows empty state when beneficiary has no batches in selected range`
8. `includes rows whose Updated date is inside the selected single-day range`

### Зависели от Settings Team TEAM-UI-002

9. `TEAM-UI-003: edit user updates row data`
10. `TEAM-UI-004: disable and enable user actions update status`

## Что было пропущено по условию

`BATCH-HISTORY-003 processing: detail exposes in-flight line statuses when rows exist`

На Stage не оказалось batch в состоянии `processing`. Тест корректно вызвал `skip`; это не ошибка.

## Общая оценка

Критического массового сбоя Stage не обнаружено. Основная часть API и UI прошла успешно. В частности, все 12 тестов Settings Integrations прошли, общая авторизация работала стабильно, а карточные сценарии не запускались.

Из семи падений:

- 2 — однозначные дефекты локаторов автотестов;
- 2 — несоответствие Provider Credentials тестов текущему API-контракту;
- 1 — cooldown бизнес-OTP;
- 1 — несоответствие History-данных ожиданиям;
- 1 — поведение перехода по `Open`, которое нужно проверить вручную.

Рекомендуемый порядок работы:

1. Исправить локаторы Beneficiaries и Team.
2. Перевести Provider Credentials тесты на `simplepay`.
3. Добавить обработку cooldown для batch SMS OTP.
4. Обновить или заново подготовить History-данные.
5. Проверить поведение `Open` на странице Payouts.
6. Повторно запустить 7 упавших и 10 зависимых тестов.
