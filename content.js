/**
 * Content Script (Isolated World)
 *
 * Две задачи:
 * 1. Блокировка autoplay — MutationObserver + снятие атрибута autoplay
 * 2. Мост настроек — читает chrome.storage.sync и передаёт в MAIN world
 *    через CustomEvent (speed-controller.js не имеет доступа к chrome API)
 *
 * Зачем ISOLATED world для моста:
 * MAIN world скрипты не могут обращаться к chrome.storage API —
 * это доступно только content scripts в isolated world.
 * Передаём настройки через CustomEvent на document.
 */

(function () {
  'use strict';

  // =========================================================================
  // Настройки по умолчанию (дублируем для автономности)
  // =========================================================================

  var DEFAULTS = {
    speedStep: 0.1,
    preferredSpeed: 2.0,
    seekStep: 10,
    overlayOpacity: 0.3,
    rememberSpeed: true,
    blockAutoplay: true,
    keys: {
      slower: 's',
      faster: 'd',
      reset: 'r',
      rewind: 'z',
      advance: 'x',
      preferred: 'g',
      toggle: 'v'
    }
  };

  // =========================================================================
  // Мост настроек: chrome.storage → MAIN world
  // =========================================================================

  /**
   * Передаёт настройки в MAIN world через CustomEvent.
   * speed-controller.js слушает событие 'vsc-settings-update' на document.
   *
   * Используем CustomEvent с detail — безопасный способ передачи данных
   * между isolated и main world. Данные клонируются structured clone алгоритмом.
   *
   * @param {Object} settings — объект настроек
   */
  function sendSettingsToMainWorld(settings) {
    document.dispatchEvent(new CustomEvent('vsc-settings-update', {
      detail: settings
    }));
  }

  /**
   * Загружаем настройки из chrome.storage.sync и отправляем в MAIN world.
   * Вызывается при инициализации и при изменении настроек.
   */
  function loadAndSendSettings() {
    chrome.storage.sync.get(DEFAULTS, function (settings) {
      sendSettingsToMainWorld(settings);
    });
  }

  /**
   * Слушаем изменения настроек в chrome.storage.
   * Срабатывает когда пользователь сохраняет настройки в popup.
   * Обновляем MAIN world без перезагрузки страницы.
   */
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    loadAndSendSettings();
  });

  // Отправляем настройки при загрузке.
  // Небольшая задержка — speed-controller.js должен успеть зарегистрировать listener.
  // requestAnimationFrame гарантирует что MAIN world скрипт уже выполнился.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      requestAnimationFrame(loadAndSendSettings);
    });
  } else {
    requestAnimationFrame(loadAndSendSettings);
  }

  /**
   * MAIN world может запросить настройки повторно через CustomEvent.
   * Это нужно если speed-controller.js загрузился позже content.js
   * и пропустил первоначальную отправку.
   */
  document.addEventListener('vsc-request-settings', function () {
    loadAndSendSettings();
  });

  // =========================================================================
  // Блокировка autoplay
  // =========================================================================

  var MEDIA_SELECTOR = 'video, audio';

  /**
   * Текущее состояние настройки blockAutoplay.
   * Обновляется при получении настроек из storage.
   * По умолчанию true — блокируем до получения настроек.
   */
  var blockAutoplayEnabled = true;

  /**
   * Обновляем флаг blockAutoplay при получении настроек.
   */
  chrome.storage.sync.get({ blockAutoplay: true }, function (result) {
    blockAutoplayEnabled = result.blockAutoplay;
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync' && changes.blockAutoplay) {
      blockAutoplayEnabled = changes.blockAutoplay.newValue;
    }
  });

  /**
   * Обезвреживает медиа-элемент: снимает autoplay, паузит, сбрасывает позицию.
   * Пропускает обработку если blockAutoplay отключён в настройках.
   *
   * @param {HTMLMediaElement} element
   */
  function disableAutoplay(element) {
    if (!blockAutoplayEnabled) return;

    // Удаляем HTML-атрибут autoplay
    if (element.hasAttribute('autoplay')) {
      element.removeAttribute('autoplay');
    }

    // Сбрасываем JS-свойство (атрибут и свойство — разные вещи в DOM)
    element.autoplay = false;

    // Паузим (безопасно вызывать даже если уже на паузе)
    element.pause();

    // Сбрасываем позицию (только если метаданные загружены)
    if (element.readyState >= 1) {
      element.currentTime = 0;
    }
  }

  /**
   * Обрабатывает добавленную DOM-ноду: ищет video/audio внутри.
   *
   * @param {Node} node
   */
  function processNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    if (node.matches(MEDIA_SELECTOR)) {
      disableAutoplay(node);
    }

    var mediaElements = node.querySelectorAll(MEDIA_SELECTOR);
    mediaElements.forEach(disableAutoplay);
  }

  // =========================================================================
  // MutationObserver — динамические медиа-элементы
  // =========================================================================

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(processNode);
    });
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  // Обработка существующих элементов при DOMContentLoaded
  document.addEventListener('DOMContentLoaded', function () {
    var existingMedia = document.querySelectorAll(MEDIA_SELECTOR);
    existingMedia.forEach(disableAutoplay);
  });

  // =========================================================================
  // Страховка: перехват события play без user activation
  // =========================================================================

  document.addEventListener('play', function (event) {
    if (!blockAutoplayEnabled) return;
    if (!event.isTrusted) return;

    // Разрешаем если есть user activation
    if (navigator.userActivation && navigator.userActivation.isActive) return;

    var target = event.target;
    if (target instanceof HTMLMediaElement) {
      target.pause();
      if (target.readyState >= 1) {
        target.currentTime = 0;
      }
    }
  }, true);
})();
