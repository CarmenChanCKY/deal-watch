(function () {
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  var MOBILE_MAX = 640;

  function isOpen() {
    return toggle && toggle.getAttribute("aria-expanded") === "true";
  }

  function setOpen(open) {
    if (!toggle || !nav) {
      return;
    }
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    nav.classList.toggle("open", open);
  }

  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      setOpen(!isOpen());
    });

    document.addEventListener("click", function (event) {
      if (!isOpen()) {
        return;
      }
      if (toggle.contains(event.target) || nav.contains(event.target)) {
        return;
      }
      setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > MOBILE_MAX && isOpen()) {
        setOpen(false);
      }
    });
  }

  var yearEls = document.querySelectorAll("[data-year]");
  var currentYear = String(new Date().getFullYear());
  Array.prototype.forEach.call(yearEls, function (el) {
    el.textContent = currentYear;
  });

  var buttons = document.querySelectorAll("[data-copy]");

  function labelFor(button) {
    return button.getAttribute("data-label") || "Copy";
  }

  function flash(button, text) {
    var original = labelFor(button);
    button.textContent = text;
    window.setTimeout(function () {
      button.textContent = original;
    }, 1500);
  }

  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener("click", function () {
      var target = document.querySelector(button.getAttribute("data-copy"));
      if (!target) {
        return;
      }
      var text = target.textContent.trim();

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            flash(button, "Copied");
          },
          function () {
            flash(button, "Copy failed");
          }
        );
        return;
      }

      // Fallback for browsers without the async clipboard API.
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(area);
      flash(button, ok ? "Copied" : "Copy failed");
    });
  });
})();
