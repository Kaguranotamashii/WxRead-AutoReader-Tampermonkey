// ==UserScript==
// @name         WxRead-AutoReader-Tampermonkey
// @name:zh-CN   微信读书自动阅读器
// @namespace    https://github.com/Kaguranotamashii/WxRead-AutoReader-Tampermonkey
// @version      1.2.0
// @description  功能丰富的微信读书自动阅读器，支持滑动条调速、断点续读、快捷键控制
// @author       WxRead-AutoReader
// @homepage     https://github.com/Kaguranotamashii/WxRead-AutoReader-Tampermonkey
// @supportURL   https://github.com/Kaguranotamashii/WxRead-AutoReader-Tampermonkey/issues
// @updateURL    https://raw.githubusercontent.com/Kaguranotamashii/WxRead-AutoReader-Tampermonkey/main/WxRead-AutoReader-Tampermonkey.js
// @downloadURL  https://raw.githubusercontent.com/Kaguranotamashii/WxRead-AutoReader-Tampermonkey/main/WxRead-AutoReader-Tampermonkey.js
// @match        https://weread.qq.com/*
// @grant        none
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function() {
  'use strict';

  // ==================== 配置参数 ====================
  const CONFIG = {
    minInterval: 100,    // 最小间隔 0.1秒
    maxInterval: 5000,   // 最大间隔 5秒
    defaultInterval: 2000, // 默认 2秒
    scrollDistance: 24,  // 滚动距离
    turnPageDelay: 3000, // 翻页延迟
    storageKey: 'wxread_autoreader_settings'
  };

  // ==================== 全局变量 ====================
  let isRunning = false;
  let isPaused = false;
  let timer = null;
  let scrollInterval = CONFIG.defaultInterval;
  let ui = null;
  let autoReader = null;
  let settings = {};

  // ==================== 工具函数 ====================
  function $(selector) { return document.querySelector(selector); }
  function getElement(className) { return document.getElementsByClassName(className)[0]; }

  function saveSettings() {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(settings));
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG.storageKey));
      return saved || {
        speed: CONFIG.defaultInterval,
        autoResume: true,
        showNotification: true
      };
    } catch {
      return { 
        speed: CONFIG.defaultInterval, 
        autoResume: true, 
        showNotification: true 
      };
    }
  }

  function notify(title, message, force = false) {
    // force参数用于强制显示重要通知（如阅读完成）
    const shouldShow = force || settings.showNotification;
    
    console.log(`通知请求: ${title} - ${message}, 强制=${force}, 设置=${settings.showNotification}, 权限=${Notification.permission}`);
    
    if (shouldShow && window.Notification) {
      if (Notification.permission === "granted") {
        try {
          const notification = new Notification(title, { 
            body: message,
            tag: 'wxread-autoreader' // 避免重复通知
          });
          
          notification.onclick = function() {
            window.focus();
            notification.close();
          };
          
          setTimeout(() => notification.close(), 5000);
          console.log('通知已显示');
          console.log(title + message);
          if (title.includes('阅读完成')) {
            alert(`📚 阅读完成: ${message}`);
          }
          
        } catch (e) {
          console.error('通知显示失败:', e);
          // 降级到alert
          if (force) {
            alert(`${title}: ${message}`);
          }
        }
      } else if (Notification.permission === "default") {
        // 如果权限未设置，重新请求
        console.log('重新请求通知权限');
        requestNotificationPermission();
        if (force) {
          alert(`${title}: ${message}`);
        }
      } else {
        console.log('通知权限被拒绝');
        if (force) {
          alert(`${title}: ${message}`);
        }
      }
    } else {
      console.log('通知被跳过 - 设置关闭或不支持');
      if (force) {
        alert(`${title}: ${message}`);
      }
    }
  }

  function fireKeyEvent(element, eventType, keyCode) {
    const event = new KeyboardEvent(eventType, {
      keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true
    });
    element.dispatchEvent(event);
  }

  function formatTime(seconds) {
    // 修复NaN问题
    if (!seconds || isNaN(seconds)) {
      seconds = CONFIG.defaultInterval;
    }
    if (seconds >= 1000) {
      return (seconds / 1000).toFixed(1) + '秒';
    } else {
      return (seconds / 1000).toFixed(2) + '秒';
    }
  }

  // ==================== 自动阅读器核心 ====================
  class AutoReader {
    constructor() {
      this.handler = null;
      this.title = '';
      this.chapter = '';
      this.app = null;
      this.clientHeight = 0;
      this.scrollHeight = 0;
      this.maxScroll = 0;
      this.pagePos = 0;
      this.scrollEnabled = true;
      this.startTime = null;
    }

    fetchPageElement() {
      try {
        const titleEl = getElement('readerTopBar_title_chapter');
        const chapterEl = getElement('readerTopBar_title_link');
        this.title = titleEl?.innerText || '微信读书';
        this.chapter = chapterEl?.innerText || '阅读中';
      } catch (err) {
        this.title = '微信读书';
        this.chapter = '阅读中';
      }

      this.app = document.getElementById('app');
      if (!this.app) return false;

      this.clientHeight = this.app.clientHeight;
      this.scrollHeight = this.app.scrollHeight;
      this.maxScroll = this.scrollHeight - this.clientHeight;
      this.scrollEnabled = true;
      
      // 🔥 关键改进：从当前滚动位置开始，而不是从头开始
      if (settings.autoResume) {
        this.pagePos = window.pageYOffset || document.documentElement.scrollTop || 0;
      } else {
        this.pagePos = 0;
      }
      
      console.log(`页面信息: 当前位置=${this.pagePos}, 最大滚动=${this.maxScroll}`);
      return true;
    }

    start() {
      if (isRunning) return;
      if (!this.fetchPageElement()) {
        ui?.updateStatus('页面未找到');
        return;
      }

      isRunning = true;
      isPaused = false;
      this.startTime = Date.now();
      this.handler = setInterval(() => this.onScroll(), scrollInterval);
      
      ui?.updateStatus('阅读中');
      notify('📖 开始阅读', `《${this.title}》- ${this.chapter}`);
      console.log(`开始阅读: ${this.title} - ${this.chapter}, 起始位置: ${this.pagePos}`);
    }

    stop() {
      if (!isRunning) return;
      isRunning = false;
      isPaused = false;
      
      if (this.handler) {
        clearInterval(this.handler);
        this.handler = null;
      }

      // 显示阅读时长
      if (this.startTime) {
        const duration = Math.round((Date.now() - this.startTime) / 1000);
        console.log(`阅读时长: ${duration}秒`);
      }

      ui?.updateStatus('已停止');
      document.title = `${this.title} - 微信读书`;
    }

    pause() {
      if (!isRunning) return;
      
      if (isPaused) {
        // 恢复
        isPaused = false;
        this.handler = setInterval(() => this.onScroll(), scrollInterval);
        ui?.updateStatus('阅读中');
        console.log('阅读已恢复');
      } else {
        // 暂停
        isPaused = true;
        if (this.handler) {
          clearInterval(this.handler);
          this.handler = null;
        }
        ui?.updateStatus('已暂停');
        console.log('阅读已暂停');
      }
    }

    toggle() {
      isRunning ? this.stop() : this.start();
    }

    updateSpeed(newInterval) {
      scrollInterval = newInterval;
      settings.speed = newInterval;
      saveSettings();
      
      if (isRunning && !isPaused) {
        clearInterval(this.handler);
        this.handler = setInterval(() => this.onScroll(), scrollInterval);
      }
    }

    jumpToProgress(percent) {
      if (!this.app) return;
      
      const targetPos = Math.round(this.maxScroll * (percent / 100));
      this.pagePos = targetPos;
      scroll(0, targetPos);
      
      console.log(`跳转到进度: ${percent}%, 位置: ${targetPos}`);
    }

    resetToTop() {
      this.pagePos = 0;
      scroll(0, 0);
      console.log('重置到页面顶部');
    }

    onScroll() {
      if (!this.scrollEnabled || !this.app) return;

      if (this.pagePos < this.maxScroll) {
        this.pagePos += CONFIG.scrollDistance;
        const progress = (Math.min(this.pagePos / this.maxScroll, 1) * 100);
        
        document.title = `${progress.toFixed(1)}% - ${this.chapter} · ${this.title}`;
        scroll(0, this.pagePos);
        ui?.updateProgress(progress);
        return;
      }

      // 翻页逻辑
      const footerButton = getElement('readerFooter_button');
      console.log('检查翻页按钮:', footerButton ? '找到' : '未找到');
      
      if (footerButton && !footerButton.disabled) {
        ui?.updateStatus('翻页中...');
        console.log('执行翻页操作');
        fireKeyEvent(document.body, "keydown", 39);
        this.scrollEnabled = false;
        
        setTimeout(() => {
          this.fetchPageElement();
          ui?.updateStatus('阅读中');
          console.log(`翻页成功: ${this.chapter}`);
        }, CONFIG.turnPageDelay);
      } else {
        console.log('没有翻页按钮或按钮被禁用，判定为阅读完成');
        const message = `阅读完成: ${this.chapter}`;
        document.title = message;
        ui?.updateStatus('阅读完成');
        // 强制显示阅读完成通知
        notify('📚 阅读完成', message, true);
        console.log('📚 阅读完成:', message);
        this.stop();
      }
    }
  }

  // ==================== 增强UI界面 ====================
  class EnhancedUI {
    constructor() {
      this.panel = null;
      this.isMinimized = false;
      // 先加载设置并初始化scrollInterval
      settings = loadSettings();
      scrollInterval = settings.speed || CONFIG.defaultInterval;
      this.createPanel();
      this.bindEvents();
    }

    createPanel() {
      const panelHTML = `
        <div id="wxread-panel" style="
          position: fixed; top: 20px; right: 20px; 
          background: #ffffff; border: 1px solid #ccc; border-radius: 8px; 
          padding: 12px; box-shadow: 0 3px 10px rgba(0,0,0,0.2); 
          z-index: 999999; font-family: Arial, sans-serif; font-size: 13px;
          width: 240px; transition: all 0.3s ease; color: #000000;
        ">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <span style="font-weight: bold; font-size: 14px; color: #000000;">📖 自动阅读器</span>
            <div>
              <button id="minimize-btn" style="border: none; background: none; cursor: pointer; padding: 2px 4px; margin-right: 4px; color: #000000;">−</button>
              <button id="close-btn" style="border: none; background: none; cursor: pointer; padding: 2px 4px; color: #000000;">✕</button>
            </div>
          </div>
          
          <div id="panel-content">
            <div id="status" style="padding: 6px 8px; background: #f5f5f5; border-radius: 4px; font-size: 12px; margin-bottom: 10px; border-left: 3px solid #4CAF50; color: #000000;">
              状态: 未启动
            </div>
            
            <div style="margin-bottom: 10px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                <span style="font-size: 12px; font-weight: 500; color: #000000;">阅读速度</span>
                <span id="speed-value" style="font-size: 12px; color: #000000; background: #f0f0f0; padding: 2px 6px; border-radius: 3px;">
                  2.0秒
                </span>
              </div>
              <input type="range" id="speed-slider" 
                min="${CONFIG.minInterval}" max="${CONFIG.maxInterval}" 
                value="${scrollInterval}" step="50"
                style="width: 100%; height: 6px; background: #ddd; border-radius: 3px; outline: none; cursor: pointer;">
              <div style="display: flex; justify-content: space-between; font-size: 10px; color: #000000; margin-top: 2px;">
                <span>0.1s</span>
                <span>5.0s</span>
              </div>
            </div>

            <div style="display: flex; gap: 6px; margin-bottom: 10px;">
              <button id="toggle-btn" style="
                flex: 2; padding: 8px; background: #4CAF50; color: #ffffff;
                border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;
              ">▶ 开始阅读</button>
              <button id="pause-btn" style="
                flex: 1; padding: 8px; background: #FF9800; color: #ffffff;
                border: none; border-radius: 4px; cursor: pointer; font-size: 12px;
              ">⏸</button>
            </div>

            <div style="margin-bottom: 10px;">
              <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px;">
                <span style="color: #000000;">阅读进度</span>
                <span id="progress-text" style="color: #000000;">0.0%</span>
              </div>
              <div style="width: 100%; height: 4px; background: #eee; border-radius: 2px; overflow: hidden; cursor: pointer;" id="progress-container">
                <div id="progress" style="height: 100%; background: linear-gradient(90deg, #4CAF50, #45a049); width: 0%; transition: width 0.3s;"></div>
              </div>
            </div>

            <div style="display: flex; gap: 4px; margin-bottom: 8px;">
              <button id="reset-btn" style="
                flex: 1; padding: 4px; background: #607D8B; color: #ffffff;
                border: none; border-radius: 3px; cursor: pointer; font-size: 10px;
              ">回到顶部</button>
              <button id="settings-btn" style="
                flex: 1; padding: 4px; background: #9E9E9E; color: #ffffff;
                border: none; border-radius: 3px; cursor: pointer; font-size: 10px;
              ">设置</button>
            </div>

            <div id="settings-panel" style="display: none; background: #f9f9f9; padding: 8px; border-radius: 4px; margin-bottom: 8px; border: 1px solid #e0e0e0;">
              <div style="margin-bottom: 6px;">
                <label style="display: flex; align-items: center; font-size: 11px; cursor: pointer; color: #000000;">
                  <input type="checkbox" id="auto-resume" style="margin-right: 6px;">
                  <span>断点续读（从当前位置开始）</span>
                </label>
              </div>
              <div style="margin-bottom: 6px;">
                <label style="display: flex; align-items: center; font-size: 11px; cursor: pointer; color: #000000;">
                  <input type="checkbox" id="show-notification" style="margin-right: 6px;">
                  <span>显示通知</span>
                </label>
              </div>
              <div style="margin-bottom: 6px;">
                <button id="test-notification" style="
                  width: 100%; padding: 4px; background: #2196F3; color: #ffffff;
                  border: none; border-radius: 3px; cursor: pointer; font-size: 10px;
                ">🔔 测试通知</button>
              </div>
            </div>

            <div style="font-size: 10px; color: #000000; text-align: center; line-height: 1.3;">
              <div>快捷键: Space=开始/停止 | P=暂停</div>
              <div>H=隐藏 | ↑↓=调速 | R=重置</div>
            </div>
          </div>
        </div>
      `;

      document.body.insertAdjacentHTML('beforeend', panelHTML);
      this.panel = $('#wxread-panel');
    }

    bindEvents() {
      $('#toggle-btn').onclick = () => autoReader.toggle();
      $('#pause-btn').onclick = () => autoReader.pause();
      $('#close-btn').onclick = () => this.hide();
      $('#minimize-btn').onclick = () => this.minimize();
      $('#reset-btn').onclick = () => autoReader.resetToTop();
      $('#settings-btn').onclick = () => this.toggleSettings();
      
      // 速度滑动条
      const slider = $('#speed-slider');
      slider.oninput = (e) => {
        const value = parseInt(e.target.value);
        scrollInterval = value;
        $('#speed-value').textContent = formatTime(value);
        autoReader.updateSpeed(value);
      };

      // 进度条点击跳转
      $('#progress-container').onclick = (e) => {
        const rect = e.target.getBoundingClientRect();
        const percent = ((e.clientX - rect.left) / rect.width) * 100;
        autoReader.jumpToProgress(percent);
      };

      // 设置选项
      $('#auto-resume').onchange = (e) => {
        settings.autoResume = e.target.checked;
        saveSettings();
      };

      $('#show-notification').onchange = (e) => {
        settings.showNotification = e.target.checked;
        saveSettings();
      };

      // 测试通知按钮
      $('#test-notification').onclick = () => {
        console.log('用户手动测试通知');
        notify('🔔 通知测试', '这是一条测试通知，如果您看到这条消息，说明通知功能正常工作！', true);
      };

      // 初始化显示正确的值
      this.updateSpeedDisplay();
    }

    updateSpeedDisplay() {
      const speedSelect = $('#speed-slider');
      const speedValue = $('#speed-value');
      
      if (speedSelect) speedSelect.value = scrollInterval;
      if (speedValue) speedValue.textContent = formatTime(scrollInterval);
      
      // 更新设置选项
      $('#auto-resume').checked = settings.autoResume || false;
      $('#show-notification').checked = settings.showNotification !== false; // 默认开启
    }

    updateStatus(status) {
      const statusEl = $('#status');
      const toggleBtn = $('#toggle-btn');
      const pauseBtn = $('#pause-btn');
      
      if (statusEl) {
        statusEl.textContent = `状态: ${status}`;
        const colors = {
          '阅读中': '#4CAF50',
          '已暂停': '#FF9800', 
          '翻页中...': '#2196F3',
          '阅读完成': '#9C27B0'
        };
        statusEl.style.borderLeftColor = colors[status] || '#4CAF50';
      }
      
      if (toggleBtn) {
        toggleBtn.textContent = isRunning ? '⏹ 停止' : '▶ 开始阅读';
        toggleBtn.style.background = isRunning ? '#f44336' : '#4CAF50';
      }

      if (pauseBtn) {
        pauseBtn.textContent = isPaused ? '▶' : '⏸';
        pauseBtn.style.background = isPaused ? '#4CAF50' : '#FF9800';
      }
    }

    updateProgress(progress) {
      const progressBar = $('#progress');
      const progressText = $('#progress-text');
      
      if (progressBar) progressBar.style.width = `${progress}%`;
      if (progressText) progressText.textContent = `${progress.toFixed(1)}%`;
    }

    minimize() {
      this.isMinimized = !this.isMinimized;
      const content = $('#panel-content');
      const btn = $('#minimize-btn');
      
      if (this.isMinimized) {
        content.style.display = 'none';
        this.panel.style.width = '120px';
        btn.textContent = '+';
      } else {
        content.style.display = 'block';
        this.panel.style.width = '240px';
        btn.textContent = '−';
      }
    }

    toggleSettings() {
      const settingsPanel = $('#settings-panel');
      settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
    }

    hide() { this.panel.style.display = 'none'; }
    show() { this.panel.style.display = 'block'; }
    
    toggle() {
      this.panel.style.display = this.panel.style.display === 'none' ? 'block' : 'none';
    }
  }

  // ==================== 快捷键 ====================
  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          autoReader.toggle();
          break;
        case 'KeyP':
          e.preventDefault();
          autoReader.pause();
          break;
        case 'KeyH':
          e.preventDefault();
          ui?.toggle();
          break;
        case 'KeyR':
          e.preventDefault();
          autoReader.resetToTop();
          break;
        case 'ArrowUp':
          e.preventDefault();
          adjustSpeed(-100);
          break;
        case 'ArrowDown':
          e.preventDefault();
          adjustSpeed(100);
          break;
        case 'Digit1':
          e.preventDefault();
          setSpeed(500);
          break;
        case 'Digit2':
          e.preventDefault();
          setSpeed(1000);
          break;
        case 'Digit3':
          e.preventDefault();
          setSpeed(2000);
          break;
        case 'Digit4':
          e.preventDefault();
          setSpeed(3000);
          break;
      }
    });
  }

  function adjustSpeed(delta) {
    const newInterval = Math.max(CONFIG.minInterval, 
      Math.min(CONFIG.maxInterval, scrollInterval + delta));
    
    if (newInterval !== scrollInterval) {
      scrollInterval = newInterval;
      $('#speed-slider').value = newInterval;
      $('#speed-value').textContent = formatTime(newInterval);
      autoReader.updateSpeed(newInterval);
    }
  }

  function setSpeed(interval) {
    scrollInterval = interval;
    $('#speed-slider').value = interval;
    $('#speed-value').textContent = formatTime(interval);
    autoReader.updateSpeed(interval);
  }

  // ==================== 初始化 ====================
  function initAudio() {
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
      audio.volume = 0.01;
      audio.loop = true;
      audio.play().catch(() => {});
    } catch (e) {}
  }

  function requestNotificationPermission() {
    if (!window.Notification) {
      console.log('浏览器不支持通知');
      return;
    }

    console.log('当前通知权限:', Notification.permission);
    
    if (Notification.permission === 'default') {
      console.log('请求通知权限...');
      Notification.requestPermission().then(permission => {
        console.log('通知权限结果:', permission);
        if (permission === 'granted') {
          notify('🚀 自动阅读器', '通知权限已开启，阅读完成时会提醒您');
        } else {
          console.log('用户拒绝了通知权限，将使用alert作为替代');
        }
      }).catch(e => {
        console.error('请求通知权限失败:', e);
      });
    } else if (Notification.permission === 'granted') {
      console.log('通知权限已授予');
      notify('🚀 自动阅读器', '插件已就绪，支持断点续读');
    } else {
      console.log('通知权限被拒绝，将使用alert作为替代');
    }
  }

  function isReaderPage() {
    return location.pathname.includes('/web/reader/') || $('#app');
  }

  function init() {
    if (!isReaderPage()) return;

    console.log('🚀 WxRead-AutoReader 初始化中...');

    setTimeout(() => {
      // 确保settings正确加载
      settings = loadSettings();
      scrollInterval = settings.speed || CONFIG.defaultInterval;
      
      ui = new EnhancedUI();
      autoReader = new AutoReader();
      bindShortcuts();
      initAudio();
      requestNotificationPermission();
      
      window.addEventListener('beforeunload', () => autoReader?.stop());
      window.autoReader = autoReader; // 调试用
      
      console.log('✅ 初始化完成');
      console.log('🔥 新功能: 断点续读、进度跳转、设置保存');
      console.log('📖 快捷键: Space=开始/停止, P=暂停, H=隐藏, R=重置, ↑↓=调速, 1-4=快速设置');
      
      // 测试通知功能
      setTimeout(() => {
        console.log('测试通知权限...');
        if (Notification.permission === 'granted') {
          console.log('✅ 通知权限正常');
        } else {
          console.log('⚠️ 通知权限未授予，将使用alert替代');
        }
      }, 2000);
    }, 1500);
  }

  // ==================== 启动 ====================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();