/* Shared front-end helpers */
document.addEventListener('DOMContentLoaded', function () {
  // Auto-dismiss success/info alerts after 6 seconds
  document.querySelectorAll('.alert-dismissible').forEach(function (el) {
    if (el.classList.contains('alert-success') || el.classList.contains('alert-info')) {
      setTimeout(function () {
        try {
          var alert = bootstrap.Alert.getOrCreateInstance(el);
          alert.close();
        } catch (e) { /* noop */ }
      }, 6000);
    }
  });

  // Confirm dialogs: any element with data-confirm
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });
  document.querySelectorAll('[data-confirm-link]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (!window.confirm(a.getAttribute('data-confirm-link'))) e.preventDefault();
    });
  });

  // Require at least one file in upload forms
  document.querySelectorAll('form.upload-form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var hasFile = false;
      form.querySelectorAll('input[type=file]').forEach(function (i) { if (i.files.length) hasFile = true; });
      if (!hasFile) { e.preventDefault(); alert('Please choose a file first.'); }
    });
  });
});

function toggleCheckboxes(formId, masterId) {
  var master = document.getElementById(masterId);
  if (!master) return;
  document.querySelectorAll('#' + formId + ' input[name=ids]').forEach(function (cb) {
    cb.checked = master.checked;
  });
}
