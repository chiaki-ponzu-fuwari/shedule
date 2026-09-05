(() => {
  const storageKey = 'recoto-legal-language';
  const supported = new Set(['ja', 'en']);

  function savedLanguage() {
    try {
      const value = localStorage.getItem(storageKey);
      return supported.has(value) ? value : null;
    } catch {
      return null;
    }
  }

  function setLanguage(language) {
    const selected = supported.has(language) ? language : 'ja';
    document.documentElement.lang = selected;
    document.querySelectorAll('[data-lang]').forEach((element) => {
      element.hidden = element.dataset.lang !== selected;
    });
    document.querySelectorAll('[data-language-button]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.languageButton === selected));
    });
    try {
      localStorage.setItem(storageKey, selected);
    } catch {
      // Language preference remains available for this page view.
    }
  }

  document.querySelectorAll('[data-language-button]').forEach((button) => {
    button.addEventListener('click', () => setLanguage(button.dataset.languageButton));
  });
  setLanguage(savedLanguage() || (navigator.language.startsWith('en') ? 'en' : 'ja'));
})();
