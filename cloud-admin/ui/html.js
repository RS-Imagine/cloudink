// Text and quoted attributes share one escaping rule for generated UI markup.
export const escapeHTML = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
