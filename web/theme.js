/* Loaded in <head>, before the stylesheet paints, so the saved theme applies with no flash.
   A theme is an attribute on <html>: light, dark, warm or contrast. No attribute means follow the system. */
(function () {
  "use strict";
  var KEY = "pipeline-theme", OK = ["light", "dark", "warm", "contrast"];
  function get() {
    try { var v = localStorage.getItem(KEY); return OK.indexOf(v) > -1 ? v : "auto"; } catch (e) { return "auto"; }
  }
  function apply(v) {
    var r = document.documentElement;
    if (v === "auto") r.removeAttribute("data-theme"); else r.setAttribute("data-theme", v);
  }
  function set(v) {
    apply(v);
    try { if (v === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* private mode: theme lasts for this visit only */ }
  }
  apply(get());
  window.PipelineTheme = { get: get, set: set };
})();
