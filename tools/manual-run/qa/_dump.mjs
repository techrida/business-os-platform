// helper: dump visible controls of the current page (roles + names), for step authoring
export async function dump(page, scope = 'body') {
  const rows = await page
    .locator(scope)
    .first()
    .evaluate((root) => {
      const sel =
        'a[href],button,input,select,textarea,[role=button],[role=tab],[role=combobox],[role=checkbox],[role=radio],[role=switch],[role=menuitem],summary,h1,h2,h3,[role=alert],[role=status]';
      return [...root.querySelectorAll(sel)]
        .filter((e) => e.offsetParent !== null || e.getClientRects().length)
        .map((e) => {
          const lbl = e.getAttribute('aria-label') || e.labels?.[0]?.innerText || '';
          const txt = (e.innerText || e.value || e.getAttribute('placeholder') || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 70);
          return `${e.tagName.toLowerCase()}[${e.getAttribute('role') || e.type || ''}] label="${lbl.trim().slice(0, 50)}" text="${txt}"${e.getAttribute('href') ? ' href=' + e.getAttribute('href').split('?')[0] : ''}${e.disabled ? ' DISABLED' : ''}`;
        });
    });
  return rows.filter(
    (r) =>
      !/Search menu|Collapse sidebar|Dev menu|Next\.js Dev Tools|href=\/(inbox|memos|customers|leads|opportunities|quotations|verification|activities|sales-orders|invoices|payments|receivables|procurement|vendors|payables|settings|$)(\s|$)/.test(
        r,
      ) || /Add lead|Mark|Put on hold/.test(r),
  );
}
