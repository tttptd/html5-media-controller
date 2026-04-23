/**
 * Speed Controller — управление скоростью воспроизведения HTML5 video/audio
 *
 * Выполняется в MAIN world для прямого доступа к playbackRate медиа-элементов.
 *
 * Функциональность (по аналогии с Video Speed Controller / igrigorik/videospeed):
 * - Overlay-индикатор текущей скорости на каждом видео
 * - Горячие клавиши: ускорение, замедление, сброс, перемотка, preferred speed
 * - Scroll wheel на overlay меняет скорость
 * - Запоминание скорости между перезагрузками (через localStorage)
 * - Автоприменение скорости при смене видео или попытке сайта сбросить rate
 *
 * Архитектура:
 * - SpeedController класс: один экземпляр на один <video>/<audio> элемент
 * - MutationObserver: обнаружение новых медиа-элементов в DOM
 * - Keyboard handler: глобальный обработчик горячих клавиш
 * - Custom element <vsc-overlay>: overlay не конфликтует с существующими элементами
 */

(function () {
  'use strict';

  // =========================================================================
  // Конфигурация по умолчанию
  // =========================================================================

  /**
   * Настройки скорости.
   * SPEED_STEP — шаг изменения при нажатии клавиши или прокрутке колеса.
   * MIN_SPEED / MAX_SPEED — границы диапазона (0.1x — 16x).
   * DEFAULT_SPEED — начальная скорость (1.0 = нормальная).
   * PREFERRED_SPEED — "любимая" скорость, переключаемая по клавише G.
   */
  var CONFIG = {
    SPEED_STEP: 0.1,
    MIN_SPEED: 0.1,
    MAX_SPEED: 16.0,
    DEFAULT_SPEED: 1.0,
    PREFERRED_SPEED: 2.0,

    /**
     * Шаг перемотки в секундах.
     * Z — назад, X — вперёд.
     */
    SEEK_STEP: 10,

    /**
     * Прозрачность overlay в неактивном состоянии (0.0 — 1.0).
     * При наведении мыши прозрачность увеличивается до 1.0.
     */
    OVERLAY_OPACITY: 0.3,

    /**
     * Время (мс) показа overlay после изменения скорости.
     * Overlay появляется, показывает текущую скорость, затем плавно исчезает.
     */
    OVERLAY_SHOW_DURATION: 1500,

    /**
     * Запоминать скорость между перезагрузками.
     * Хранится в localStorage по ключу 'vsc-speed'.
     */
    REMEMBER_SPEED: true,

    /**
     * Горячие клавиши.
     * Каждое значение — код клавиши (event.key).
     * Модификаторы не используются — клавиши работают без Ctrl/Alt/Shift.
     */
    KEYS: {
      SLOWER: 's',       // Уменьшить скорость на SPEED_STEP
      FASTER: 'd',       // Увеличить скорость на SPEED_STEP
      RESET: 'r',        // Сбросить на DEFAULT_SPEED (1.0x)
      REWIND: 'z',       // Перемотка назад на SEEK_STEP секунд
      ADVANCE: 'x',      // Перемотка вперёд на SEEK_STEP секунд
      PREFERRED: 'g',    // Переключить между текущей и PREFERRED_SPEED
      TOGGLE: 'v'        // Показать/скрыть overlay
    }
  };

  // =========================================================================
  // Приём настроек из content.js (ISOLATED world → MAIN world)
  // =========================================================================

  /**
   * Content.js передаёт настройки из chrome.storage через CustomEvent.
   * MAIN world не имеет доступа к chrome.storage API — это единственный
   * способ получить пользовательские настройки.
   *
   * При получении настроек обновляем CONFIG на лету.
   * Это позволяет менять настройки в popup без перезагрузки страницы.
   */
  document.addEventListener('vsc-settings-update', function (e) {
    var settings = e.detail;
    if (!settings) return;

    // Обновляем числовые настройки (с валидацией)
    if (typeof settings.speedStep === 'number' && settings.speedStep > 0) {
      CONFIG.SPEED_STEP = settings.speedStep;
    }
    if (typeof settings.preferredSpeed === 'number' && settings.preferredSpeed > 0) {
      CONFIG.PREFERRED_SPEED = settings.preferredSpeed;
    }
    if (typeof settings.seekStep === 'number' && settings.seekStep > 0) {
      CONFIG.SEEK_STEP = settings.seekStep;
    }
    if (typeof settings.overlayOpacity === 'number') {
      CONFIG.OVERLAY_OPACITY = settings.overlayOpacity;
      // Обновляем opacity на всех существующих overlay
      controllers.forEach(function (ctrl) {
        if (ctrl.overlay) {
          ctrl.overlay.style.setProperty('--vsc-opacity', CONFIG.OVERLAY_OPACITY);
        }
      });
    }
    if (typeof settings.rememberSpeed === 'boolean') {
      CONFIG.REMEMBER_SPEED = settings.rememberSpeed;
    }

    // Обновляем горячие клавиши
    if (settings.keys && typeof settings.keys === 'object') {
      if (settings.keys.slower) CONFIG.KEYS.SLOWER = settings.keys.slower;
      if (settings.keys.faster) CONFIG.KEYS.FASTER = settings.keys.faster;
      if (settings.keys.reset) CONFIG.KEYS.RESET = settings.keys.reset;
      if (settings.keys.rewind) CONFIG.KEYS.REWIND = settings.keys.rewind;
      if (settings.keys.advance) CONFIG.KEYS.ADVANCE = settings.keys.advance;
      if (settings.keys.preferred) CONFIG.KEYS.PREFERRED = settings.keys.preferred;
      if (settings.keys.toggle) CONFIG.KEYS.TOGGLE = settings.keys.toggle;
    }
  });

  /**
   * Запрашиваем настройки у content.js.
   * На случай если speed-controller.js загрузился после
   * первоначальной отправки настроек из content.js.
   */
  document.dispatchEvent(new CustomEvent('vsc-request-settings'));

  // =========================================================================
  // Хранение скорости в localStorage
  // =========================================================================

  /**
   * Ключ для localStorage.
   * Используем специфичный префикс чтобы не конфликтовать с данными сайта.
   */
  var STORAGE_KEY = 'vsc-playback-speed';

  /**
   * Загрузить сохранённую скорость из localStorage.
   * Возвращает число или null если ничего не сохранено.
   * Валидирует значение — если сохранён мусор, возвращает null.
   */
  function loadSavedSpeed() {
    if (!CONFIG.REMEMBER_SPEED) return null;

    try {
      var val = localStorage.getItem(STORAGE_KEY);
      if (val === null) return null;

      var speed = parseFloat(val);
      // Проверяем что значение — конечное число в допустимом диапазоне
      if (isFinite(speed) && speed >= CONFIG.MIN_SPEED && speed <= CONFIG.MAX_SPEED) {
        return speed;
      }
    } catch (e) {
      // localStorage может быть недоступен (private browsing, iframe restrictions)
    }
    return null;
  }

  /**
   * Сохранить текущую скорость в localStorage.
   * Тихо игнорирует ошибки — сохранение скорости не критично.
   */
  function saveSpeed(speed) {
    if (!CONFIG.REMEMBER_SPEED) return;

    try {
      localStorage.setItem(STORAGE_KEY, speed.toString());
    } catch (e) {
      // Игнорируем — quota exceeded, private browsing и т.д.
    }
  }

  // =========================================================================
  // Текущая глобальная скорость
  // =========================================================================

  /**
   * Глобальная скорость, применяемая ко всем видео на странице.
   * Загружаем из localStorage или используем дефолт.
   */
  var currentSpeed = loadSavedSpeed() || CONFIG.DEFAULT_SPEED;

  // =========================================================================
  // CSS для overlay
  // =========================================================================

  /**
   * Стили overlay инжектируются один раз в <head>.
   * Используем Shadow DOM внутри custom element,
   * но базовое позиционирование задаём здесь.
   *
   * vsc-overlay — custom element, позиционируется абсолютно
   * относительно контейнера видео.
   */
  var CSS = '\
    vsc-overlay {\
      position: absolute;\
      top: 8px;\
      left: 8px;\
      z-index: 2147483647;\
      pointer-events: auto;\
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;\
      font-size: 13px;\
      font-weight: 600;\
      line-height: 1;\
      color: #fff;\
      background: rgba(0, 0, 0, 0.7);\
      padding: 4px 8px;\
      border-radius: 4px;\
      cursor: pointer;\
      user-select: none;\
      white-space: nowrap;\
      transition: opacity 0.3s ease;\
      opacity: 0;\
    }\
    vsc-overlay.vsc-visible {\
      opacity: var(--vsc-opacity, 0.3);\
    }\
    vsc-overlay.vsc-active {\
      opacity: 1 !important;\
    }\
    vsc-overlay:hover {\
      opacity: 1 !important;\
    }\
    vsc-overlay.vsc-hidden {\
      display: none !important;\
    }\
\
    /* ===================================================================\
     * Кнопка Play/Pause — toggle по центру видео.\
     * Подложка (скруглённый прямоугольник) + круг с иконкой + бренд.\
     * =================================================================== */\
\
    /* --- Подложка: полупрозрачный серый прямоугольник --- */\
    vsc-playpause {\
      position: absolute;\
      top: 50%;\
      left: 50%;\
      transform: translate(-50%, -50%);\
      z-index: 2147483646;\
      pointer-events: none;\
      cursor: pointer;\
      user-select: none;\
      /* Подложка — скруглённый прямоугольник, не круг */\
      background: rgba(40, 40, 40, 0.80);\
      border-radius: 12px;\
      padding: 20px 28px 14px;\
      /* Вертикальная раскладка: иконка + бренд */\
      display: flex;\
      flex-direction: column;\
      align-items: center;\
      gap: 8px;\
      /* Не закрываем всё видео */\
      max-width: 40%;\
      max-height: 50%;\
      transition: opacity 0.25s ease, transform 0.15s ease;\
      opacity: 0;\
    }\
\
    /* --- Состояние: видео на паузе → показываем play --- */\
    vsc-playpause.vsc-paused {\
      opacity: 0.7;\
      pointer-events: auto;\
    }\
\
    /* --- Состояние: видео играет → скрыта, hover на контейнере показывает pause --- */\
    vsc-playpause.vsc-playing {\
      opacity: 0;\
      pointer-events: none;\
    }\
    :hover > vsc-playpause.vsc-playing {\
      opacity: 0.5;\
      pointer-events: auto;\
    }\
\
    /* Hover на самой подложке */\
    vsc-playpause:hover {\
      opacity: 1 !important;\
      transform: translate(-50%, -50%) scale(1.05);\
    }\
    vsc-playpause:active {\
      transform: translate(-50%, -50%) scale(0.97);\
    }\
\
    /* --- Круг с иконкой play/pause внутри подложки --- */\
    .vsc-pp-icon {\
      width: 56px;\
      height: 56px;\
      border-radius: 50%;\
      background: rgba(255, 255, 255, 0.1);\
      border: 2px solid rgba(255, 255, 255, 0.6);\
      display: flex;\
      align-items: center;\
      justify-content: center;\
      flex-shrink: 0;\
    }\
\
    /* --- Переключение иконок по состоянию --- */\
    vsc-playpause.vsc-paused .vsc-icon-play  { display: block; }\
    vsc-playpause.vsc-paused .vsc-icon-pause { display: none; }\
    vsc-playpause.vsc-playing .vsc-icon-play  { display: none; }\
    vsc-playpause.vsc-playing .vsc-icon-pause { display: flex; }\
\
    /* Треугольник play — смещён на 4px вправо для оптического центра */\
    .vsc-icon-play {\
      width: 0;\
      height: 0;\
      margin-left: 4px;\
      border-style: solid;\
      border-width: 12px 0 12px 22px;\
      border-color: transparent transparent transparent rgba(255, 255, 255, 0.9);\
    }\
\
    /* Две вертикальные полоски pause */\
    .vsc-icon-pause {\
      display: flex;\
      gap: 6px;\
      align-items: center;\
    }\
    .vsc-icon-pause span {\
      display: block;\
      width: 6px;\
      height: 22px;\
      background: rgba(255, 255, 255, 0.9);\
      border-radius: 1px;\
    }\
\
    /* --- Бре��д: иконка расширения + название под кнопкой --- */\
    .vsc-pp-brand {\
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\
      font-size: 10px;\
      font-weight: 500;\
      letter-spacing: 0.5px;\
      color: rgba(255, 255, 255, 0.45);\
      white-space: nowrap;\
      line-height: 1;\
    }\
\
    /* --- Адаптивность: компактный вид для маленьких видео --- */\
    vsc-playpause.vsc-compact {\
      padding: 12px 16px 10px;\
      gap: 4px;\
      border-radius: 8px;\
    }\
    vsc-playpause.vsc-compact .vsc-pp-icon {\
      width: 36px;\
      height: 36px;\
    }\
    vsc-playpause.vsc-compact .vsc-icon-play {\
      border-width: 8px 0 8px 14px;\
      margin-left: 3px;\
    }\
    vsc-playpause.vsc-compact .vsc-icon-pause span {\
      width: 4px;\
      height: 14px;\
    }\
    vsc-playpause.vsc-compact .vsc-icon-pause {\
      gap: 4px;\
    }\
    vsc-playpause.vsc-compact .vsc-pp-brand {\
      display: none;\
    }\
\
    vsc-playpause.vsc-btn-hidden {\
      display: none !important;\
    }\
  ';

  /**
   * Инжектируем CSS один раз.
   * Используем <style> элемент в <head> (или documentElement если head ещё нет).
   */
  function injectCSS() {
    // Проверяем, не инжектировали ли уже
    if (document.querySelector('style[data-vsc-styles]')) return;

    var style = document.createElement('style');
    style.setAttribute('data-vsc-styles', '');
    style.textContent = CSS;

    // document_start — <head> может ещё не существовать
    var target = document.head || document.documentElement;
    if (target) {
      target.appendChild(style);
    } else {
      // Крайний edge case: ждём когда появится хоть что-то
      document.addEventListener('DOMContentLoaded', function () {
        document.head.appendChild(style);
      });
    }
  }

  // =========================================================================
  // SpeedController — класс управления одним медиа-элементом
  // =========================================================================

  /**
   * Каждый экземпляр SpeedController привязан к одному <video> или <audio>.
   * Создаёт overlay, применяет скорость, слушает попытки сброса скорости сайтом.
   *
   * @param {HTMLMediaElement} media — video или audio элемент
   */
  function SpeedController(media) {
    this.media = media;
    this.overlay = null;
    this.playBtn = null;       // Кнопка play поверх видео
    this.showTimer = null;
    this.isOverlayHidden = false; // Пользователь скрыл overlay клавишей V

    this._init();
  }

  /**
   * Инициализация контроллера:
   * 1. Создаём overlay элемент
   * 2. Вставляем overlay рядом с видео
   * 3. Применяем текущую скорость
   * 4. Слушаем событие ratechange — если сайт сбросит скорость, мы её вернём
   */
  SpeedController.prototype._init = function () {
    // Помечаем элемент чтобы не создавать повторный контроллер
    this.media.__vsc = this;

    this._applySpeed(currentSpeed, false);
    this._listenRateChange();

    // Overlay и кнопка play/pause требуют ненулевого размера видео
    // для позиционирования и проверки минимального размера.
    // При document_start видео может быть ещё не отрендерено (offsetWidth = 0).
    // В этом случае откладываем создание UI до появления размеров.
    if (this.media.tagName !== 'AUDIO' && this.media.offsetWidth === 0) {
      this._deferUI();
    } else {
      this._initUI();
    }
  };

  /**
   * Создание визуальных элементов (overlay, play/pause кнопка).
   * Вызывается сразу или отложенно, когда вид��о получит размеры.
   */
  SpeedController.prototype._initUI = function () {
    // Защита от повторного вызова
    if (this._uiReady) return;
    this._uiReady = true;

    this._createOverlay();
    this._createPlayButton();
    this._attachOverlay();
    this._listenPlayPause();
  };

  /**
   * Отложенная инициализация UI.
   * Видео ещё не и��еет размеров (offsetWidth = 0) — ждём.
   *
   * Стратег��я: слушаем loadedmetadata (видео получило размеры ��з файла)
   * + резервный таймер 2 сек (некоторые видео уже имеют metadata,
   * но ещё не отрендерены в layout).
   * Также используем ResizeObserver если доступен — ловит момент
   * когда элемент получает размеры от layout engine.
   */
  SpeedController.prototype._deferUI = function () {
    var self = this;

    function tryInit() {
      if (self._uiReady) return;
      if (self.media.offsetWidth > 0) {
        self._initUI();
      }
    }

    // loadedmetadata — видео узнало свои размеры из файла
    this.media.addEventListener('loadedmetadata', tryInit);

    // loadeddata — первый кадр готов, layout точно посчитан
    this.media.addEventListener('loadeddata', tryInit);

    // ResizeObserver — ловит момент когда элемент получает размеры
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        tryInit();
        if (self._uiReady) {
          ro.disconnect();
        }
      });
      ro.observe(this.media);
    }

    // Резервный таймер — на случай если события не пришли
    setTimeout(tryInit, 2000);
  };

  /**
   * Создание overlay элемента.
   * Используем custom element <vsc-overlay> чтобы не конфликтовать
   * с CSS и JS сайта (маловероятно что сайт стилизует vsc-overlay).
   */
  SpeedController.prototype._createOverlay = function () {
    this.overlay = document.createElement('vsc-overlay');
    this.overlay.textContent = this._formatSpeed(currentSpeed);

    // Устанавливаем прозрачность через CSS custom property
    this.overlay.style.setProperty('--vsc-opacity', CONFIG.OVERLAY_OPACITY);

    // Показываем overlay только если скорость не стандартная
    if (currentSpeed !== CONFIG.DEFAULT_SPEED) {
      this.overlay.classList.add('vsc-visible');
    }

    // -----------------------------------------------------------------------
    // Scroll wheel на overlay — изменение скорости
    // -----------------------------------------------------------------------

    /**
     * Колесо мыши на overlay меняет скорость.
     * deltaY < 0 (вверх) — ускорение, deltaY > 0 (вниз) — замедление.
     * preventDefault блокирует прокрутку страницы при наведении на overlay.
     */
    var self = this;
    this.overlay.addEventListener('wheel', function (e) {
      e.preventDefault();
      e.stopPropagation();

      var direction = e.deltaY < 0 ? 1 : -1;
      var newSpeed = currentSpeed + (direction * CONFIG.SPEED_STEP);
      setGlobalSpeed(newSpeed);
    }, { passive: false });

    // -----------------------------------------------------------------------
    // Двойной клик на overlay — сброс скорости
    // -----------------------------------------------------------------------
    this.overlay.addEventListener('dblclick', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setGlobalSpeed(CONFIG.DEFAULT_SPEED);
    });
  };

  /**
   * Создание кнопки Play/Pause поверх видео.
   *
   * Поведение:
   * - Видео на паузе → кнопка видна полупрозрачно с иконкой ▶ (play)
   * - Видео играет → кнопка скрыта, но при hover на видео появляется
   *   с иконкой ❚❚ (pause) и позволяет остановить воспроизведение
   * - Клик — toggle play/pause
   *
   * Зачем: не все видео имеют встроенные контролы (controls атрибут).
   * После блокировки autoplay пользователь видит застывший кадр
   * без возможности запустить воспроизведение.
   *
   * Элемент <vsc-playpause> содержит обе иконки внутри,
   * CSS-классы vsc-paused / vsc-playing переключают видимость.
   */
  SpeedController.prototype._createPlayButton = function () {
    // Для audio — не создаём (нет визуальной области)
    if (this.media.tagName === 'AUDIO') return;

    // Не создаём для крошечных видео (превью, фоновые анимации)
    if (this.media.offsetWidth < 40 || this.media.offsetHeight < 40) return;

    this.playBtn = document.createElement('vsc-playpause');

    // Круг-контейнер для иконки play/pause
    var ppIcon = document.createElement('div');
    ppIcon.className = 'vsc-pp-icon';

    // Иконка Play (CSS-треугольник через border)
    var iconPlay = document.createElement('div');
    iconPlay.className = 'vsc-icon-play';

    // Иконка Pause (две вертикальные полоски)
    var iconPause = document.createElement('div');
    iconPause.className = 'vsc-icon-pause';
    iconPause.appendChild(document.createElement('span'));
    iconPause.appendChild(document.createElement('span'));

    ppIcon.appendChild(iconPlay);
    ppIcon.appendChild(iconPause);
    this.playBtn.appendChild(ppIcon);

    // Бренд: иконка расширения + название под кнопкой
    var brand = document.createElement('div');
    brand.className = 'vsc-pp-brand';
    brand.textContent = '\u23E9 HTML5 Media Controller'; // ⏩
    this.playBtn.appendChild(brand);

    // Адаптивность: компактный вид для маленьких видео.
    // Скрывает бренд, уменьшает padding и иконку.
    var btnSize = Math.min(this.media.offsetWidth, this.media.offsetHeight);
    if (btnSize < 200) {
      this.playBtn.classList.add('vsc-compact');
    }

    // Начальное состояние
    this.playBtn.classList.add(this.media.paused ? 'vsc-paused' : 'vsc-playing');

    var self = this;

    /**
     * Клик — toggle play/pause.
     * Клик = user gesture → monkey-patched play() пропустит вызов.
     */
    this.playBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (self.media.paused) {
        self.media.play();
      } else {
        self.media.pause();
      }
    });
  };

  /**
   * Слушаем события play/pause на медиа-элементе.
   * Переключаем CSS-класс кнопки: vsc-paused ↔ vsc-playing.
   * Это управляет и видимостью кнопки, и отображаемой иконкой.
   */
  SpeedController.prototype._listenPlayPause = function () {
    if (!this.playBtn) return;

    var btn = this.playBtn;

    /**
     * Устанавливает состояние кнопки.
     * @param {boolean} paused — true = иконка play (видна), false = иконка pause (скрыта до hover)
     */
    function setState(paused) {
      btn.classList.toggle('vsc-paused', paused);
      btn.classList.toggle('vsc-playing', !paused);
    }

    // play/playing → состояние "playing" (иконка pause, скрыта до hover на видео)
    this.media.addEventListener('play', function () { setState(false); });
    this.media.addEventListener('playing', function () { setState(false); });

    // pause → состояние "paused" (иконка play, видна)
    this.media.addEventListener('pause', function () { setState(true); });

    // ended → показываем play для повторного просмотра
    this.media.addEventListener('ended', function () { setState(true); });
  };

  /**
   * Вставка overlay в DOM рядом с медиа-элементом.
   *
   * Стратегия позиционирования:
   * - Ищем ближайшего родителя с position: relative/absolute/fixed/sticky
   * - Если такого нет — делаем непосредственного родителя position: relative
   * - Вставляем overlay как sibling или child этого контейнера
   *
   * Для <audio> элементов overlay не создаётся (нет визуального контейнера).
   */
  SpeedController.prototype._attachOverlay = function () {
    var media = this.media;

    // Для audio-элементов пропускаем overlay — нет видимой области для размещения.
    // Скорость всё равно управляется горячими клавишами.
    if (media.tagName === 'AUDIO') return;

    // Не показываем overlay для крошечных видео (превью, фоновые анимации).
    // 40x40 — минимальный размер при котором overlay имеет смысл.
    if (media.offsetWidth < 40 || media.offsetHeight < 40) return;

    /**
     * Ищем подходящий контейнер для абсолютного позиционирования.
     * Overlay позиционирован absolute — ему нужен родитель с position != static.
     * Проходим вверх по дереву от родителя видео.
     */
    var container = media.parentElement;
    if (!container) return;

    var containerStyle = getComputedStyle(container);

    // Если контейнер — static, делаем его relative.
    // Это безопасная операция — relative без top/left/right/bottom
    // не меняет визуальное положение элемента.
    if (containerStyle.position === 'static') {
      container.style.position = 'relative';
    }

    container.appendChild(this.overlay);

    // Вставляем кнопку play в тот же контейнер.
    // Она позиционирована absolute с top/left 50% + transform,
    // поэтому окажется по центру видео.
    if (this.playBtn) {
      container.appendChild(this.playBtn);
    }
  };

  /**
   * Форматирование скорости для отображения.
   * Показываем одну цифру после запятой, кроме целых значений.
   * Примеры: 1.0x → "1.0x", 1.5x → "1.5x", 2.0x → "2.0x"
   *
   * Всегда показываем одну цифру после запятой для единообразия.
   */
  SpeedController.prototype._formatSpeed = function (speed) {
    return speed.toFixed(1) + 'x';
  };

  /**
   * Применить скорость к медиа-элементу.
   *
   * @param {number} speed — новая скорость
   * @param {boolean} showOverlay — показать overlay с анимацией
   */
  SpeedController.prototype._applySpeed = function (speed, showOverlay) {
    // Устанавливаем playbackRate.
    // Это встроенное свойство HTMLMediaElement — меняет скорость воспроизведения.
    // Значение 1.0 = нормальная скорость, 2.0 = вдвое быстрее, 0.5 = вдвое медленнее.
    this.media.playbackRate = speed;

    if (!this.overlay) return;

    // Обновляем текст overlay
    this.overlay.textContent = this._formatSpeed(speed);

    // Показываем/скрываем overlay в зависимости от скорости.
    // При стандартной скорости (1.0x) overlay скрыт — не засоряет экран.
    // При нестандартной — показан полупрозрачно, чтобы пользователь видел текущую скорость.
    if (speed !== CONFIG.DEFAULT_SPEED) {
      this.overlay.classList.add('vsc-visible');
    } else {
      this.overlay.classList.remove('vsc-visible');
    }

    // Показываем overlay ярко на короткое время после изменения скорости.
    // Это визуальная обратная связь — пользователь видит что скорость изменилась.
    if (showOverlay) {
      this._flashOverlay();
    }
  };

  /**
   * "Вспышка" overlay — показать ярко, затем вернуть к обычной прозрачности.
   * Используется при изменении скорости горячими клавишами или scroll wheel.
   */
  SpeedController.prototype._flashOverlay = function () {
    if (!this.overlay || this.isOverlayHidden) return;

    var overlay = this.overlay;

    // Добавляем класс vsc-active — opacity: 1 (полностью видимый)
    overlay.classList.add('vsc-active');
    overlay.classList.add('vsc-visible');

    // Убираем vsc-active через OVERLAY_SHOW_DURATION мс.
    // CSS transition обеспечивает плавное затухание.
    clearTimeout(this.showTimer);
    this.showTimer = setTimeout(function () {
      overlay.classList.remove('vsc-active');
    }, CONFIG.OVERLAY_SHOW_DURATION);
  };

  /**
   * Слушаем событие ratechange на медиа-элементе.
   *
   * Зачем: некоторые сайты (YouTube, Netflix) принудительно сбрасывают
   * playbackRate на 1.0 при переключении видео, рекламных вставках,
   * или по таймеру. Мы ловим это и возвращаем нашу скорость.
   *
   * Защита от рекурсии: флаг _vscSettingRate предотвращает бесконечный цикл
   * (мы меняем rate → событие → мы опять меняем rate → ...).
   */
  SpeedController.prototype._listenRateChange = function () {
    var self = this;

    this.media.addEventListener('ratechange', function () {
      // Если это мы сами меняем скорость — не реагируем (защита от рекурсии)
      if (self.media.__vscSettingRate) return;

      // Если текущий playbackRate отличается от нашей целевой скорости —
      // значит сайт сбросил скорость. Возвращаем нашу.
      if (self.media.playbackRate !== currentSpeed) {
        self.media.__vscSettingRate = true;
        self.media.playbackRate = currentSpeed;
        self.media.__vscSettingRate = false;
      }
    });
  };

  /**
   * Переключить видимость overlay (клавиша V).
   */
  SpeedController.prototype.toggleOverlay = function () {
    this.isOverlayHidden = !this.isOverlayHidden;

    if (!this.overlay) return;

    if (this.isOverlayHidden) {
      this.overlay.classList.add('vsc-hidden');
    } else {
      this.overlay.classList.remove('vsc-hidden');
      this._flashOverlay();
    }
  };

  /**
   * Удаление контроллера.
   * Убираем overlay из DOM и снимаем метку с медиа-элемента.
   */
  SpeedController.prototype.destroy = function () {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    if (this.playBtn && this.playBtn.parentNode) {
      this.playBtn.parentNode.removeChild(this.playBtn);
    }
    clearTimeout(this.showTimer);
    delete this.media.__vsc;
  };

  // =========================================================================
  // Реестр контроллеров
  // =========================================================================

  /**
   * Все активные контроллеры.
   * Используем массив а не Map/Set для совместимости со старыми браузерами.
   */
  var controllers = [];

  /**
   * Создать контроллер для медиа-элемента, если его ещё нет.
   *
   * @param {HTMLMediaElement} media
   */
  function attachController(media) {
    // Пропускаем если контроллер уже создан
    if (media.__vsc) return;

    var ctrl = new SpeedController(media);
    controllers.push(ctrl);
  }

  // =========================================================================
  // Глобальное управление скоростью
  // =========================================================================

  /**
   * Установить скорость для ВСЕХ медиа-элементов на странице.
   * Это главная точка входа для изменения скорости.
   *
   * @param {number} speed — новая скорость
   */
  function setGlobalSpeed(speed) {
    // Ограничиваем скорость допустимым диапазоном
    speed = Math.max(CONFIG.MIN_SPEED, Math.min(CONFIG.MAX_SPEED, speed));

    // Округляем до одного знака после запятой,
    // чтобы избежать floating point артефактов (0.1 + 0.1 + 0.1 = 0.30000000000000004)
    speed = Math.round(speed * 10) / 10;

    currentSpeed = speed;
    saveSpeed(speed);

    // Применяем ко всем контроллерам
    controllers.forEach(function (ctrl) {
      ctrl._applySpeed(speed, true);
    });
  }

  // =========================================================================
  // Обнаружение медиа-элементов
  // =========================================================================

  /**
   * MutationObserver для отслеживания динамически добавленных video/audio.
   * SPA-приложения постоянно добавляют и удаляют элементы — observer ловит это.
   */
  function initObserver() {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          // Сам узел — медиа-элемент
          if (node instanceof HTMLMediaElement) {
            attachController(node);
            return;
          }

          // Ищем медиа-элементы внутри добавленного поддерева
          if (node.querySelectorAll) {
            var medias = node.querySelectorAll('video, audio');
            medias.forEach(attachController);
          }
        });

        // Удалённые ноды — чистим контроллеры чтобы не утекала память
        mutation.removedNodes.forEach(function (node) {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          if (node instanceof HTMLMediaElement && node.__vsc) {
            var idx = controllers.indexOf(node.__vsc);
            if (idx !== -1) {
              controllers[idx].destroy();
              controllers.splice(idx, 1);
            }
            return;
          }

          // Ищем медиа внутри удалённого поддерева
          if (node.querySelectorAll) {
            var medias = node.querySelectorAll('video, audio');
            medias.forEach(function (media) {
              if (media.__vsc) {
                var idx = controllers.indexOf(media.__vsc);
                if (idx !== -1) {
                  controllers[idx].destroy();
                  controllers.splice(idx, 1);
                }
              }
            });
          }
        });
      });
    });

    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
    }
  }

  /**
   * Начальный проход — подключаем контроллеры ко всем существующим медиа-элементам.
   */
  function scanExisting() {
    var medias = document.querySelectorAll('video, audio');
    medias.forEach(attachController);
  }

  // =========================================================================
  // Горячие клавиши
  // =========================================================================

  /**
   * Глобальный обработчик горячих клавиш.
   *
   * Правила:
   * - Игнорируем нажатия в полях ввода (input, textarea, contenteditable)
   *   чтобы не мешать пользователю набирать текст
   * - Игнорируем нажатия с модификаторами (Ctrl/Alt/Meta)
   *   чтобы не перехватывать системные комбинации
   * - Работаем только если на странице есть хотя бы одно видео
   */
  function initKeyboardHandler() {
    document.addEventListener('keydown', function (e) {
      // Не перехватываем горячие клавиши если пользователь в поле ввода.
      // tagName проверяем для input/textarea/select.
      // isContentEditable — для div[contenteditable] и подобных.
      var tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.target.isContentEditable) return;

      // Не перехватываем комбинации с модификаторами —
      // Ctrl+S, Alt+D и т.д. должны работать как обычно
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // Нет активных контроллеров — нечем управлять
      if (controllers.length === 0) return;

      var key = e.key.toLowerCase();
      var handled = true;

      switch (key) {
        case CONFIG.KEYS.SLOWER:
          // Уменьшить скорость на один шаг
          setGlobalSpeed(currentSpeed - CONFIG.SPEED_STEP);
          break;

        case CONFIG.KEYS.FASTER:
          // Увеличить скорость на один шаг
          setGlobalSpeed(currentSpeed + CONFIG.SPEED_STEP);
          break;

        case CONFIG.KEYS.RESET:
          // Сброс на стандартную скорость (1.0x)
          setGlobalSpeed(CONFIG.DEFAULT_SPEED);
          break;

        case CONFIG.KEYS.REWIND:
          // Перемотка назад на SEEK_STEP секунд.
          // Применяем ко всем видео — обычно на странице одно активное.
          controllers.forEach(function (ctrl) {
            ctrl.media.currentTime = Math.max(0, ctrl.media.currentTime - CONFIG.SEEK_STEP);
          });
          break;

        case CONFIG.KEYS.ADVANCE:
          // Перемотка вперёд на SEEK_STEP секунд.
          // Не проверяем duration — браузер сам ограничит.
          controllers.forEach(function (ctrl) {
            ctrl.media.currentTime = ctrl.media.currentTime + CONFIG.SEEK_STEP;
          });
          break;

        case CONFIG.KEYS.PREFERRED:
          // Переключение между текущей скоростью и "любимой" (PREFERRED_SPEED).
          // Если текущая === preferred → сброс на 1.0x.
          // Если текущая !== preferred → переключение на preferred.
          if (currentSpeed === CONFIG.PREFERRED_SPEED) {
            setGlobalSpeed(CONFIG.DEFAULT_SPEED);
          } else {
            setGlobalSpeed(CONFIG.PREFERRED_SPEED);
          }
          break;

        case CONFIG.KEYS.TOGGLE:
          // Показать/скрыть overlay на всех видео
          controllers.forEach(function (ctrl) {
            ctrl.toggleOverlay();
          });
          break;

        default:
          handled = false;
      }

      // Блокируем дальнейшую обработку клавиши сайтом,
      // чтобы не было конфликтов (например, S на YouTube открывает субтитры)
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true); // capture: true — ловим до обработчиков сайта
  }

  // =========================================================================
  // Инициализация
  // =========================================================================

  injectCSS();
  initObserver();
  initKeyboardHandler();

  // Сканируем существующие элементы при DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanExisting);
  } else {
    // DOM уже загружен — сканируем сразу
    scanExisting();
  }

  console.log('[HTML5 Media Controller] Speed controller loaded — текущая скорость: ' + currentSpeed + 'x');
})();
