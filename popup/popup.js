/**
 * Popup скрипт — управление настройками расширения.
 *
 * Настройки хранятся в chrome.storage.sync — синхронизируются между
 * устройствами пользователя (если включена синхронизация Chrome).
 *
 * Поток данных:
 * 1. Popup загружает настройки из chrome.storage.sync
 * 2. Пользователь меняет значения в форме
 * 3. При нажатии "Сохранить" — записываем в chrome.storage.sync
 * 4. Content script читает настройки из chrome.storage.sync при загрузке
 *    и слушает chrome.storage.onChanged для обновления на лету
 *
 * Примечание: speed-controller.js работает в MAIN world и не имеет
 * доступа к chrome.storage API. Поэтому content.js (ISOLATED world)
 * служит мостом: читает настройки и передаёт их в MAIN world
 * через window.postMessage или CustomEvent.
 */

(function () {
  'use strict';

  // =========================================================================
  // Настройки по умолчанию
  // =========================================================================

  /**
   * Значения по умолчанию — совпадают с CONFIG в speed-controller.js.
   * Дублирование неизбежно: popup и content script — разные контексты.
   */
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
  // DOM-ссылки
  // =========================================================================

  var els = {
    speedStep: document.getElementById('speedStep'),
    preferredSpeed: document.getElementById('preferredSpeed'),
    seekStep: document.getElementById('seekStep'),
    overlayOpacity: document.getElementById('overlayOpacity'),
    rememberSpeed: document.getElementById('rememberSpeed'),
    blockAutoplay: document.getElementById('blockAutoplay'),
    keySlower: document.getElementById('keySlower'),
    keyFaster: document.getElementById('keyFaster'),
    keyReset: document.getElementById('keyReset'),
    keyRewind: document.getElementById('keyRewind'),
    keyAdvance: document.getElementById('keyAdvance'),
    keyPreferred: document.getElementById('keyPreferred'),
    keyToggle: document.getElementById('keyToggle'),
    saveBtn: document.getElementById('saveBtn'),
    resetBtn: document.getElementById('resetBtn'),
    status: document.getElementById('status')
  };

  // =========================================================================
  // Загрузка настроек из chrome.storage.sync
  // =========================================================================

  /**
   * Читаем настройки и заполняем форму.
   * chrome.storage.sync.get принимает объект с дефолтными значениями —
   * если ключ отсутствует, используется дефолт.
   */
  function loadSettings() {
    chrome.storage.sync.get(DEFAULTS, function (settings) {
      els.speedStep.value = settings.speedStep;
      els.preferredSpeed.value = settings.preferredSpeed;
      els.seekStep.value = settings.seekStep;
      els.overlayOpacity.value = settings.overlayOpacity;
      els.rememberSpeed.checked = settings.rememberSpeed;
      els.blockAutoplay.checked = settings.blockAutoplay;

      // Горячие клавиши — показываем в верхнем регистре для читаемости
      els.keySlower.value = settings.keys.slower.toUpperCase();
      els.keyFaster.value = settings.keys.faster.toUpperCase();
      els.keyReset.value = settings.keys.reset.toUpperCase();
      els.keyRewind.value = settings.keys.rewind.toUpperCase();
      els.keyAdvance.value = settings.keys.advance.toUpperCase();
      els.keyPreferred.value = settings.keys.preferred.toUpperCase();
      els.keyToggle.value = settings.keys.toggle.toUpperCase();
    });
  }

  // =========================================================================
  // Сохранение настроек
  // =========================================================================

  /**
   * Собираем значения из формы и записываем в chrome.storage.sync.
   * parseFloat/parseInt для числовых полей — input может вернуть строку.
   */
  function saveSettings() {
    var settings = {
      speedStep: parseFloat(els.speedStep.value) || DEFAULTS.speedStep,
      preferredSpeed: parseFloat(els.preferredSpeed.value) || DEFAULTS.preferredSpeed,
      seekStep: parseInt(els.seekStep.value, 10) || DEFAULTS.seekStep,
      overlayOpacity: parseFloat(els.overlayOpacity.value) || DEFAULTS.overlayOpacity,
      rememberSpeed: els.rememberSpeed.checked,
      blockAutoplay: els.blockAutoplay.checked,
      keys: {
        slower: (els.keySlower.value || DEFAULTS.keys.slower).toLowerCase(),
        faster: (els.keyFaster.value || DEFAULTS.keys.faster).toLowerCase(),
        reset: (els.keyReset.value || DEFAULTS.keys.reset).toLowerCase(),
        rewind: (els.keyRewind.value || DEFAULTS.keys.rewind).toLowerCase(),
        advance: (els.keyAdvance.value || DEFAULTS.keys.advance).toLowerCase(),
        preferred: (els.keyPreferred.value || DEFAULTS.keys.preferred).toLowerCase(),
        toggle: (els.keyToggle.value || DEFAULTS.keys.toggle).toLowerCase()
      }
    };

    chrome.storage.sync.set(settings, function () {
      showStatus();
    });
  }

  /**
   * Сброс настроек на значения по умолчанию.
   * Записываем DEFAULTS в storage и перезаполняем форму.
   */
  function resetSettings() {
    chrome.storage.sync.set(DEFAULTS, function () {
      loadSettings();
      showStatus();
    });
  }

  // =========================================================================
  // UI-обратная связь
  // =========================================================================

  /**
   * Показать сообщение "Настройки сохранены" на 1.5 секунды.
   */
  function showStatus() {
    els.status.classList.add('visible');
    setTimeout(function () {
      els.status.classList.remove('visible');
    }, 1500);
  }

  // =========================================================================
  // Обработка ввода клавиш
  // =========================================================================

  /**
   * Поля ввода горячих клавиш: при нажатии клавиши записываем её в поле
   * и переходим к следующему элементу. Это удобнее чем набирать символ —
   * пользователь просто нажимает нужную клавишу.
   */
  document.querySelectorAll('.key-input').forEach(function (input) {
    input.addEventListener('keydown', function (e) {
      e.preventDefault();

      // Игнорируем модификаторы и спецклавиши
      if (['Control', 'Alt', 'Shift', 'Meta', 'Tab', 'Escape'].indexOf(e.key) !== -1) {
        return;
      }

      this.value = e.key.toUpperCase();
      this.blur(); // Снимаем фокус — визуальный сигнал что ввод принят
    });
  });

  // =========================================================================
  // Обработчики кнопок
  // =========================================================================

  els.saveBtn.addEventListener('click', saveSettings);
  els.resetBtn.addEventListener('click', resetSettings);

  // Загружаем настройки при открытии popup
  loadSettings();
})();
