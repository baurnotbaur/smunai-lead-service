/**
 * Виджет подключения сайта к сервису заявок.
 *
 *   <script src="https://ВАШ-СЕРВИС/embed.js?key=ПУБЛИЧНЫЙ_КЛЮЧ" defer></script>
 *
 * Перехватывает отправку любых форм с атрибутом data-lead-form и шлёт данные в CRM.
 * Поля берутся по name: name, phone, email, comment (или message).
 * Дополнительно к каждой заявке прикладываются UTM-метки, referrer и адрес страницы.
 */
(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    return all[all.length - 1];
  })();

  var src = new URL(script.src, location.href);
  var ENDPOINT = src.origin + '/api/v1/leads';
  var KEY = src.searchParams.get('key') || '';
  var SELECTOR = src.searchParams.get('selector') || '[data-lead-form]';
  var STORE = 'ld_attribution';

  if (!KEY) {
    console.warn('[leads] не указан key в адресе embed.js — заявки уходить не будут');
  }

  /* ---- атрибуция: запоминаем первый визит с метками ---- */

  function readAttribution() {
    var q = new URLSearchParams(location.search);
    var fresh = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) {
      if (q.get(k)) fresh[k] = q.get(k).slice(0, 120);
    });
    if (!fresh.utm_source && document.referrer && !document.referrer.includes(location.host)) {
      try { fresh.utm_source = new URL(document.referrer).hostname; fresh.utm_medium = 'referral'; } catch (e) {}
    }
    try {
      if (Object.keys(fresh).length) {
        localStorage.setItem(STORE, JSON.stringify(fresh));
        return fresh;
      }
      return JSON.parse(localStorage.getItem(STORE) || '{}');
    } catch (e) {
      return fresh;
    }
  }

  var attribution = readAttribution();

  /* ---- отправка ---- */

  function submitLead(data) {
    var payload = Object.assign({}, attribution, data, {
      key: KEY,
      page_url: location.href.slice(0, 500),
      referrer: document.referrer.slice(0, 500),
    });
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (res) {
        if (!res.ok) throw Object.assign(new Error(res.message || 'Ошибка отправки'), { response: res });
        return res;
      });
  }

  function collect(form) {
    var data = {};
    new FormData(form).forEach(function (value, key) {
      if (typeof value !== 'string') return;
      data[key] = value;
    });
    data.form_id = form.id || form.getAttribute('data-lead-form') || '';
    return data;
  }

  function bind(form) {
    if (form.__leadBound) return;
    form.__leadBound = true;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var button = form.querySelector('[type="submit"]');
      var label = button && button.textContent;
      if (button) { button.disabled = true; button.textContent = 'Отправляем…'; }

      submitLead(collect(form))
        .then(function (res) {
          form.reset();
          form.dispatchEvent(new CustomEvent('lead:success', { bubbles: true, detail: res }));
        })
        .catch(function (err) {
          form.dispatchEvent(new CustomEvent('lead:error', { bubbles: true, detail: err }));
          console.error('[leads]', err);
        })
        .finally(function () {
          if (button) { button.disabled = false; button.textContent = label; }
        });
    });
  }

  function scan() {
    document.querySelectorAll(SELECTOR).forEach(bind);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();

  // публичный API для ручной отправки: window.Leads.submit({name, phone, ...})
  window.Leads = { submit: submitLead, endpoint: ENDPOINT, key: KEY, bind: bind, scan: scan };
})();
