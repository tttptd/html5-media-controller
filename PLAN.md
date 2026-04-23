# HTML5 HTML5 Media Controller — План

## v1.0 — Autoplay Blocker ✅
- Manifest V3, content scripts на все URL
- main-world.js: monkey-patch play()
- content.js: MutationObserver + снятие autoplay

## v2.0 — Speed Controller ✅
По аналогии с [videospeed](https://github.com/igrigorik/videospeed):

- speed-controller.js (MAIN world): overlay, горячие клавиши, playbackRate
- Горячие клавиши: S/D (±speed), R (reset), Z/X (±seek), G (preferred), V (toggle overlay)
- Scroll wheel на overlay
- Запоминание скорости (localStorage)
- Автовосстановление при ratechange
- Popup настроек (chrome.storage.sync)
- Мост настроек: content.js (ISOLATED) → speed-controller.js (MAIN) через CustomEvent
- Настраиваемые клавиши, шаг, preferred speed, opacity, seek step
- Переключатель blockAutoplay в настройках
