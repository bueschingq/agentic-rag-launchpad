// Pages the widget stays off: the ones the deployment excludes (login, checkout…), and
// Sitefinity's page editor, where a chat button would sit on top of the editing tools.

// "/login" matches /login and everything under it; "*" matches anything, so "/checkout/*",
// "*/account/*" or "*.aspx" work too. Case-insensitive, like most CMS URLs. The same rules
// as the content sync's include and exclude paths.
export function pathMatches(path: string, patterns: readonly string[]): boolean {
  const p = path.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (!pattern.includes("*")) {
      const prefix = pattern.replace(/\/+$/, "");
      return p === prefix || p.startsWith(`${prefix}/`) || (prefix === "" && p === "/");
    }
    const re = new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    return re.test(p);
  });
}

export interface EditorSignals {
  pathname: string;
  search: string;
  // document.body's classes, and whether the page is framed and has editor containers.
  bodyClasses?: readonly string[];
  framedWithContainers?: boolean;
}

// Sitefinity opens pages for editing in two ways:
// - MVC and Web Forms (up to 14.x): the page URL plus /Action/Edit, with "sfPageEditor" on the
//   body (templates add "sfTemplateEditor").
// - The ASP.NET Core and Next.js renderers (14.1+): the page URL plus ?sfaction=edit, in an
//   iframe of the backend, with containers marked data-sfcontainer.
// Preview modes (/Action/Preview, sfaction=preview) show the page as visitors see it, chat included.
export function inSitefinityEditor({ pathname, search, bodyClasses = [], framedWithContainers = false }: EditorSignals): boolean {
  if (/\/action\/edit(\/|$)/i.test(pathname)) return true;
  if (new URLSearchParams(search).get("sfaction")?.toLowerCase() === "edit") return true;
  if (bodyClasses.includes("sfPageEditor") || bodyClasses.includes("sfTemplateEditor")) return true;
  return framedWithContainers;
}

export function editorSignals(win: Window = window): EditorSignals {
  const doc = win.document;
  let framed = false;
  try {
    framed = win.top !== win;
  } catch {
    framed = true;
  }
  return {
    pathname: win.location.pathname,
    search: win.location.search,
    bodyClasses: doc.body ? [...doc.body.classList] : [],
    framedWithContainers: framed && doc.querySelector("[data-sfcontainer]") !== null,
  };
}
