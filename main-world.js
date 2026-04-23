/**
 * Main World Script — перехват HTMLMediaElement.prototype.play()
 *
 * Этот скрипт выполняется в контексте страницы (world: "MAIN"),
 * что позволяет напрямую модифицировать прототипы DOM-объектов.
 *
 * Стратегия:
 * - Сохраняем оригинальный метод play()
 * - Заменяем его на обёртку, которая проверяет наличие user gesture
 * - Если пользователь не взаимодействовал со страницей — блокируем воспроизведение
 * - Если был клик/нажатие клавиши — пропускаем play() как обычно
 *
 * Зачем нужен именно MAIN world:
 * Content scripts в ISOLATED world не имеют доступа к JS-объектам страницы.
 * Сайты вызывают element.play() из своего JS — перехватить это можно только
 * из того же контекста выполнения (MAIN world).
 */

(function () {
  'use strict';

  // =========================================================================
  // Флаг user gesture
  // =========================================================================

  /**
   * Отслеживаем, было ли недавнее взаимодействие пользователя.
   * Браузер сам отслеживает user activation, но мы не можем к ней обратиться
   * из monkey-patched метода — поэтому ведём свой флаг.
   */
  let hasUserGesture = false;

  /**
   * Таймер для сброса флага.
   * После взаимодействия даём окно в 1 секунду, в течение которого
   * вызовы play() считаются инициированными пользователем.
   * 1 секунда — компромисс: достаточно для обработки событий в цепочке
   * click → handler → play(), но не настолько долго, чтобы сайт
   * мог злоупотребить окном.
   */
  let gestureTimer = null;

  /**
   * Список событий, которые считаются user gesture.
   * - click: клик мышью (основное взаимодействие)
   * - keydown: нажатие клавиши (пробел для play/pause и т.д.)
   * - touchstart: касание на мобильных/тач-устройствах
   * - pointerdown: унифицированное событие указателя (покрывает мышь и тач)
   */
  const GESTURE_EVENTS = ['click', 'keydown', 'touchstart', 'pointerdown'];

  /**
   * Длительность окна после user gesture, в течение которого play() разрешён.
   */
  const GESTURE_WINDOW_MS = 1000;

  /**
   * Обработчик user gesture.
   * Устанавливает флаг и запускает таймер на его сброс.
   * Используем capture: true чтобы поймать событие до того,
   * как его может перехватить и остановить (stopPropagation) скрипт страницы.
   */
  function onUserGesture() {
    hasUserGesture = true;

    // Сбрасываем предыдущий таймер, если пользователь
    // взаимодействует повторно до истечения окна
    if (gestureTimer !== null) {
      clearTimeout(gestureTimer);
    }

    gestureTimer = setTimeout(function () {
      hasUserGesture = false;
      gestureTimer = null;
    }, GESTURE_WINDOW_MS);
  }

  // Регистрируем слушатели на фазе capture для максимальной надёжности
  GESTURE_EVENTS.forEach(function (eventName) {
    document.addEventListener(eventName, onUserGesture, true);
  });

  // =========================================================================
  // Monkey-patch HTMLMediaElement.prototype.play
  // =========================================================================

  /**
   * Сохраняем ссылку на оригинальный метод play().
   * Это критически важно — без неё мы не сможем вызвать
   * настоящий play() когда пользователь действительно хочет воспроизведение.
   */
  const originalPlay = HTMLMediaElement.prototype.play;

  /**
   * Подменённый метод play().
   *
   * Логика:
   * 1. Если есть флаг user gesture → вызываем оригинальный play()
   * 2. Если элемент имеет атрибут data-autoplay-allowed → пропускаем
   *    (на случай, если пользователь захочет добавить whitelist)
   * 3. Иначе → паузим элемент и возвращаем rejected Promise
   *
   * Возвращаем Promise, потому что оригинальный play() возвращает Promise.
   * Сайты могут обрабатывать .catch() — возвращаем корректную ошибку,
   * чтобы не ломать обработку ошибок на странице.
   */
  HTMLMediaElement.prototype.play = function () {
    // Пользователь взаимодействовал — разрешаем воспроизведение
    if (hasUserGesture) {
      return originalPlay.call(this);
    }

    // Элемент явно разрешён через data-атрибут (whitelist механизм)
    if (this.hasAttribute('data-autoplay-allowed')) {
      return originalPlay.call(this);
    }

    // Автовоспроизведение без user gesture — блокируем
    // Паузим на случай, если элемент уже начал воспроизведение
    // (например, через атрибут autoplay до нашего перехвата)
    this.pause();

    // Возвращаем rejected Promise с той же ошибкой,
    // которую браузер выдаёт при блокировке autoplay
    return Promise.reject(
      new DOMException(
        'Autoplay blocked by HTML5 Autoplay Blocker extension',
        'NotAllowedError'
      )
    );
  };

  // Лог для отладки — видно в консоли DevTools
  console.log('[Autoplay Blocker] Main world script loaded — play() перехвачен');
})();
