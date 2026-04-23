/**
 * Content Script (Isolated World) — блокировка autoplay через DOM-манипуляции
 *
 * Этот скрипт работает в изолированном мире (ISOLATED world).
 * Он не имеет доступа к JS-контексту страницы, но может манипулировать DOM.
 *
 * Стратегия:
 * - Удаляем атрибут autoplay у всех <video> и <audio> элементов
 * - Принудительно паузим элементы, которые начали воспроизведение
 * - Используем MutationObserver для отслеживания динамически добавленных элементов
 *
 * Зачем нужен этот скрипт в дополнение к main-world.js:
 * - Атрибут autoplay обрабатывается браузером ДО выполнения JS
 * - Некоторые элементы могут начать воспроизведение через атрибут,
 *   минуя вызов play() в JS
 * - MutationObserver ловит элементы, которые добавляются в DOM динамически
 *   (SPA-навигация, lazy loading, бесконечная прокрутка)
 */

(function () {
  'use strict';

  // =========================================================================
  // CSS-селектор для медиа-элементов
  // =========================================================================

  /**
   * Селектор для поиска video и audio элементов.
   * Используется в querySelectorAll и при проверке добавленных нод.
   */
  const MEDIA_SELECTOR = 'video, audio';

  // =========================================================================
  // Обработка отдельного медиа-элемента
  // =========================================================================

  /**
   * Обезвреживает один медиа-элемент:
   * 1. Удаляет атрибут autoplay — предотвращает автозапуск браузером
   * 2. Паузит элемент — останавливает уже начавшееся воспроизведение
   * 3. Сбрасывает позицию — возвращает в начало, чтобы пользователь
   *    не пропустил контент при ручном запуске
   *
   * @param {HTMLMediaElement} element — video или audio элемент
   */
  function disableAutoplay(element) {
    // Удаляем HTML-атрибут autoplay.
    // Без этого браузер может повторно запустить воспроизведение
    // при определённых условиях (например, при перемещении элемента в DOM)
    if (element.hasAttribute('autoplay')) {
      element.removeAttribute('autoplay');
    }

    // Также сбрасываем JS-свойство autoplay.
    // Атрибут и свойство — разные вещи в DOM API.
    // removeAttribute убирает HTML-атрибут, но JS-свойство может остаться true.
    element.autoplay = false;

    // Паузим элемент. pause() безопасен даже если элемент уже на паузе.
    // Важно вызвать именно pause(), а не просто убрать autoplay,
    // потому что элемент мог уже начать воспроизведение.
    element.pause();

    // Сбрасываем позицию воспроизведения в начало.
    // Без этого пользователь может пропустить первые секунды контента,
    // которые успели проиграть до нашего перехвата.
    // Проверяем readyState: currentTime можно менять только если
    // метаданные загружены (readyState >= 1 / HAVE_METADATA)
    if (element.readyState >= 1) {
      element.currentTime = 0;
    }
  }

  // =========================================================================
  // Обработка поддерева DOM
  // =========================================================================

  /**
   * Ищет и обезвреживает все медиа-элементы внутри данного узла.
   * Нужна для обработки добавленных поддеревьев через MutationObserver.
   *
   * Проверяем сам узел (может быть video/audio)
   * и всех потомков (может быть div с video внутри).
   *
   * @param {Node} node — добавленный DOM-узел
   */
  function processNode(node) {
    // MutationObserver может сообщать о текстовых нодах и комментариях —
    // у них нет matches() и querySelectorAll(), пропускаем
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    // Проверяем сам узел: может быть непосредственно <video> или <audio>
    if (node.matches(MEDIA_SELECTOR)) {
      disableAutoplay(node);
    }

    // Проверяем потомков: узел может быть контейнером (div, section),
    // внутри которого находятся медиа-элементы
    var mediaElements = node.querySelectorAll(MEDIA_SELECTOR);
    mediaElements.forEach(disableAutoplay);
  }

  // =========================================================================
  // MutationObserver — отслеживание динамических изменений DOM
  // =========================================================================

  /**
   * MutationObserver следит за добавлением новых нод в DOM.
   *
   * Зачем: SPA-приложения (React, Vue, Angular) добавляют контент динамически.
   * Видео может появиться в DOM через секунды или минуты после загрузки страницы.
   * Без observer мы бы пропустили все динамически добавленные медиа-элементы.
   *
   * Настройки:
   * - childList: true — следим за добавлением/удалением дочерних нод
   * - subtree: true — следим за всем поддеревом, а не только прямыми потомками
   *
   * Производительность:
   * MutationObserver работает асинхронно — браузер группирует мутации
   * и вызывает callback пачками, не блокируя рендеринг.
   */
  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      // Обрабатываем только добавленные ноды.
      // Удалённые ноды нас не интересуют — если элемент убрали,
      // он и так перестаёт воспроизводиться.
      mutation.addedNodes.forEach(processNode);
    });
  });

  // Начинаем наблюдение за document.documentElement (корневой <html> элемент).
  // run_at: document_start гарантирует, что скрипт выполнится до парсинга <body>,
  // но <html> уже существует — можем привязать observer.
  //
  // Если documentElement ещё не существует (крайне редкий edge case),
  // ждём DOMContentLoaded.
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    });
  }

  // =========================================================================
  // Обработка уже существующих элементов
  // =========================================================================

  /**
   * При DOMContentLoaded обрабатываем все медиа-элементы,
   * которые были в HTML-разметке с самого начала.
   *
   * MutationObserver мог пропустить элементы, которые были
   * в начальном HTML до подключения observer.
   * Этот проход — страховка на такой случай.
   */
  document.addEventListener('DOMContentLoaded', function () {
    var existingMedia = document.querySelectorAll(MEDIA_SELECTOR);
    existingMedia.forEach(disableAutoplay);
  });

  /**
   * Дополнительная страховка: слушаем событие play на уровне document.
   * Если какой-то элемент всё-таки начал воспроизведение
   * (например, через хитрый timing или Web API, который мы не учли),
   * ловим событие play и паузим элемент.
   *
   * Используем capture phase (третий аргумент true),
   * чтобы поймать событие до того, как его обработают
   * скрипты страницы и потенциально отменят всплытие.
   *
   * Проверяем isTrusted: нас интересуют только реальные события
   * воспроизведения, а не синтетические (dispatchEvent).
   *
   * Важно: НЕ блокируем если пользователь взаимодействовал.
   * Определяем это через navigator.userActivation.isActive —
   * стандартный API браузера для проверки user activation state.
   */
  document.addEventListener('play', function (event) {
    // Пропускаем синтетические события
    if (!event.isTrusted) {
      return;
    }

    // Проверяем, есть ли активная user activation.
    // navigator.userActivation — стандартный API (Chrome 72+).
    // isActive = true, если пользователь недавно взаимодействовал.
    if (navigator.userActivation && navigator.userActivation.isActive) {
      return;
    }

    var target = event.target;

    // Проверяем, что событие пришло от медиа-элемента
    if (target instanceof HTMLMediaElement) {
      target.pause();

      // Сбрасываем позицию если метаданные загружены
      if (target.readyState >= 1) {
        target.currentTime = 0;
      }
    }
  }, true); // capture: true — ловим на фазе погружения

  console.log('[Autoplay Blocker] Content script loaded — DOM-наблюдение активно');
})();
