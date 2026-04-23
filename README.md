# HTML5 Autoplay Blocker

Chrome-расширение, которое останавливает автовоспроизведение `<video>` и `<audio>` на всех веб-страницах.

---

## Содержание

- [Проблема](#проблема)
- [Решение](#решение)
- [Как это работает](#как-это-работает)
- [Установка](#установка)
- [Тестирование](#тестирование)
- [Whitelist (разрешить autoplay для элемента)](#whitelist)
- [Структура файлов](#структура-файлов)
- [Ограничения](#ограничения)

---

## Проблема

Многие сайты автоматически запускают видео и аудио при загрузке страницы. Браузер Chrome имеет встроенную политику autoplay, но она не всегда срабатывает — особенно на сайтах, которые пользователь часто посещает (Chrome повышает их Media Engagement Index).

## Решение

Расширение блокирует autoplay двумя способами одновременно:

1. **Перехват `play()` в JavaScript** — если сайт вызывает `element.play()` программно без взаимодействия пользователя, вызов блокируется.
2. **Удаление атрибута `autoplay` из DOM** — предотвращает автозапуск, который инициирует сам браузер при парсинге HTML.

Ручное воспроизведение (клик по кнопке play) работает нормально.

## Как это работает

### Main World Script (`main-world.js`)

Выполняется в контексте JavaScript страницы. Подменяет метод `HTMLMediaElement.prototype.play()`:

- Отслеживает user gesture (click, keydown, touchstart, pointerdown)
- После взаимодействия пользователя открывает окно в 1 секунду, в течение которого `play()` разрешён
- Без user gesture — `play()` возвращает rejected Promise с ошибкой `NotAllowedError` (как при обычной блокировке autoplay браузером)

### Content Script (`content.js`)

Работает в изолированном мире. Манипулирует DOM:

- **MutationObserver** следит за добавлением новых элементов в DOM (SPA, динамическая загрузка)
- Удаляет атрибут `autoplay`, паузит элемент, сбрасывает `currentTime`
- Слушает событие `play` на уровне document — страховка на случай обхода основных механизмов
- Проверяет `navigator.userActivation` чтобы не мешать ручному воспроизведению

## Установка

### Шаг 1 — Скачать расширение

Клонируйте или скачайте директорию проекта на компьютер.

### Шаг 2 — Открыть страницу расширений Chrome

1. Откройте Chrome
2. Введите в адресной строке: `chrome://extensions`
3. Нажмите Enter

### Шаг 3 — Включить режим разработчика

В правом верхнем углу страницы расширений включите переключатель **«Режим разработчика»** (Developer mode).

### Шаг 4 — Загрузить расширение

1. Нажмите кнопку **«Загрузить распакованное расширение»** (Load unpacked)
2. Выберите директорию `html5-video` (ту, где лежит `manifest.json`)
3. Расширение появится в списке

### Шаг 5 — Проверить

Откройте любую страницу с автовоспроизведением видео. Видео не должно запуститься автоматически.

В DevTools → Console должны появиться сообщения:
```
[Autoplay Blocker] Main world script loaded — play() перехвачен
[Autoplay Blocker] Content script loaded — DOM-наблюдение активно
```

## Тестирование

### Быстрый тест

Создайте HTML-файл:

```html
<!DOCTYPE html>
<html>
<body>
  <h1>Autoplay Test</h1>
  <video autoplay muted loop width="400">
    <source src="https://www.w3schools.com/html/mov_bbb.mp4" type="video/mp4">
  </video>

  <h2>Programmatic play</h2>
  <video id="vid2" muted width="400">
    <source src="https://www.w3schools.com/html/mov_bbb.mp4" type="video/mp4">
  </video>
  <script>
    // Попытка программного autoplay
    document.getElementById('vid2').play().catch(e => {
      console.log('Autoplay blocked:', e.message);
    });
  </script>
</body>
</html>
```

Ожидаемый результат: оба видео стоят на паузе.

### Что проверить

| Сценарий | Ожидание |
|----------|----------|
| Страница с `<video autoplay>` | Видео на паузе |
| Сайт вызывает `element.play()` | Воспроизведение заблокировано |
| Клик по кнопке play на плеере | Воспроизведение работает |
| SPA-навигация (новое видео в DOM) | Новое видео тоже заблокировано |
| YouTube / Twitter | Autoplay заблокирован |

## Whitelist

Чтобы разрешить autoplay для конкретного элемента, добавьте ему data-атрибут:

```html
<video data-autoplay-allowed autoplay>
  ...
</video>
```

Этот механизм работает только для перехвата `play()` (main-world.js). Content script всё равно снимет атрибут `autoplay`.

## Структура файлов

```
html5-video/
├── manifest.json      — Manifest V3, объявление content scripts
├── main-world.js      — Перехват play() в контексте страницы
├── content.js         — MutationObserver + DOM-манипуляции
├── icons/             — Иконки расширения (16, 48, 128 px)
├── README.md          — Эта инструкция
└── PLAN.md            — План разработки
```

## Ограничения

1. **Иконки** — нужно добавить PNG-иконки в `icons/` (16x16, 48x48, 128x128). Без них расширение работает, но отображается дефолтная иконка.

2. **Muted autoplay** — Chrome разрешает autoplay для muted видео по умолчанию. Расширение блокирует и его, что может сломать фоновые анимации на некоторых сайтах.

3. **Web Components / Shadow DOM** — MutationObserver не проникает внутрь closed Shadow DOM. Элементы внутри закрытых Shadow DOM могут не блокироваться.

4. **Iframe из другого origin** — content scripts инжектятся в iframe (`all_frames: true`), но cross-origin iframe могут иметь ограничения.

5. **Service Worker media** — расширение не блокирует воспроизведение через Audio API (`new Audio()`) если оно не привязано к DOM-элементу.
