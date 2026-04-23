# Chrome Extension: Block HTML5 Autoplay

## Context
Расширение Chrome, останавливающее autoplay для любого `<video>` и `<audio>`. Директория пуста — пишем с нуля.

Требования:
- Подробные комментарии в коде
- README с подробной инструкцией
- План сохранить в директорию проекта

## Файлы

| Файл | Назначение |
|------|-----------|
| `manifest.json` | Manifest V3, content scripts на все URL |
| `main-world.js` | Main world — monkey-patch `play()`, блок programmatic autoplay |
| `content.js` | Isolated world — MutationObserver, снятие autoplay, pause |
| `README.md` | Инструкция по установке и использованию |
| `PLAN.md` | Этот план |

## Подход

Две стратегии блокировки:

1. **Main world script** (`"world": "MAIN"`) — перехват `HTMLMediaElement.prototype.play()`. Блокирует вызовы `play()` из JS если нет user gesture.
2. **Content script** (`"world": "ISOLATED"`) — MutationObserver снимает атрибут `autoplay`, паузит элементы. Ловит динамически добавленные.

### manifest.json
- `manifest_version: 3`
- Два content script: ISOLATED (content.js) и MAIN (main-world.js)
- `"run_at": "document_start"` — до загрузки контента
- `<all_urls>` — все страницы
- Без лишних permissions

### main-world.js
- Сохранить оригинальный `HTMLMediaElement.prototype.play`
- Слушать user gesture events (click/keydown/touchstart/pointerdown)
- При gesture — ставить флаг на 1 сек
- Подменённый `play()` — если нет флага, pause + return rejected Promise
- Подробные комментарии к каждому блоку

### content.js
- `document_start`: MutationObserver на добавление нод
- При обнаружении video/audio: removeAttribute('autoplay'), pause(), currentTime = 0
- DOMContentLoaded: обработать существующие элементы
- Подробные комментарии

### README.md
- Описание проблемы и решения
- Как работает (обе стратегии)
- Установка (developer mode, load unpacked)
- Тестирование
- Ограничения

## Верификация
1. `chrome://extensions` → Developer mode → Load unpacked
2. Тест на сайтах с autoplay
3. Проверить ручной play работает
4. Проверить динамические элементы
