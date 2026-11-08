// Keep native form submission: credentials go directly to Keycloak.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('kc-form-login');
  const password = document.getElementById('password');
  const toggle = document.getElementById('kitchen-password-toggle');
  const submit = document.getElementById('kc-login');
  if (!form || !password || !toggle || !submit) return;

  const submitLabel = submit.querySelector('span').textContent;
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    const reveal = password.type === 'password';
    password.type = reveal ? 'text' : 'password';
    toggle.textContent = reveal ? toggle.dataset.hide : toggle.dataset.show;
    toggle.setAttribute('aria-pressed', String(reveal));
  });
  form.addEventListener('submit', event => {
    if (form.getAttribute('aria-busy') === 'true') {
      event.preventDefault();
      return;
    }
    form.setAttribute('aria-busy', 'true');
    submit.disabled = true;
    submit.querySelector('span').textContent = submit.dataset.submitting;
  });
  // Restore controls if the browser brings this page back from its cache.
  window.addEventListener('pageshow', () => {
    form.removeAttribute('aria-busy');
    submit.disabled = false;
    submit.querySelector('span').textContent = submitLabel;
  });
});
