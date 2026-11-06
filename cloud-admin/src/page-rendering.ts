export async function sanitizePublicHtml(html: string): Promise<string> {
  return new HTMLRewriter()
    .on('script,base,iframe,object,embed,form,meta[http-equiv]', {
      element(element) {
        element.remove();
      },
    })
    .on('*', {
      element(element) {
        for (const [name] of [...element.attributes])
          if (name.toLowerCase().startsWith('on')) element.removeAttribute(name);
      },
    })
    .on('head', {
      element(element) {
        element.append('<script src="/theme.js"></script>', { html: true });
      },
    })
    .on('body', {
      element(element) {
        element.append('<script src="/client.js"></script>', { html: true });
      },
    })
    .on('body', {
      element(element) {
        element.append('<script src="/analytics.js" defer></script>', { html: true });
      },
    })
    .transform(new Response(html))
    .text();
}
