import { expect, test, type Page } from '@playwright/test';
import { signInAs, type Signed } from '../helpers/memo-flow';

const labels = [
  'Company registration certificate',
  'PAN or VAT certificate',
  'Authorised signatory ID',
];
const pan = labels[1]!;
const row = (page: Page, label: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) });

async function saveUpload(page: Page, label: string, name: string, replace = false) {
  const fileRow = row(page, label);
  if (replace) await fileRow.getByRole('button', { name: `Change ${label}` }).click();
  const choose = page.waitForEvent('filechooser');
  const trigger = replace
    ? page.getByRole('dialog').getByRole('button', { name: 'Replace file' })
    : fileRow.getByRole('button', { name: `Upload ${label}` });
  await trigger.click();
  await (
    await choose
  ).setFiles({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(
      replace
        ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgMVoAAAEsAN/qVL6wAAAAAElFTkSuQmCC'
        : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwazkIAAJvAXxaFZv2AAAAAElFTkSuQmCC',
      'base64',
    ),
  });
  const preview = page.getByRole('dialog', { name });
  const image = preview.getByRole('img', { name });
  await expect(image).toBeVisible({ timeout: 60_000 });
  const versionPreview = await image.getAttribute('src');
  await preview.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(fileRow.getByText('Pending', { exact: true })).toBeVisible();
  return versionPreview;
}

async function submit(page: Page) {
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Submit for review', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Submit for review', exact: true })).toHaveCount(0);
}

test('Sales replaces rejected evidence and the reviewer approves the new round', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const opened: Signed[] = [];
  const origin = baseURL ?? 'https://app.localhost';
  try {
    const sales = await signInAs(browser, origin, 'sales');
    opened.push(sales);
    const reviewer = await signInAs(browser, origin, 'founder');
    opened.push(reviewer);
    const create = sales.page;
    const review = reviewer.page;
    await create.goto('/customers/new');
    await create.waitForLoadState('networkidle');
    const customer = `Verification review ${Date.now()}`;
    await create.getByLabel('Organization legal name').fill(customer);
    await create.getByLabel('Address', { exact: true }).fill('Fixture road');
    await create.getByLabel('City', { exact: true }).fill('Kathmandu');
    await create.getByLabel('Full name').fill('Sales Contact');
    await create.getByLabel('Email', { exact: true }).fill('contact@example.test');
    await create.getByRole('button', { name: 'Create Organization', exact: true }).click();
    await create.getByRole('button', { name: 'Start verification' }).click();
    await expect(create).toHaveURL(/\/verification\/[0-9a-f-]{36}$/);
    const url = create.url();
    let firstPreview: string | null = null;
    for (const [index, label] of labels.entries()) {
      const preview = await saveUpload(create, label, `evidence-${index}.png`);
      if (label === pan) firstPreview = preview;
    }
    await submit(create);
    await review.goto(url, { waitUntil: 'domcontentloaded' });
    const finalApproval = review.getByRole('button', { name: 'Approve customer', exact: true });
    await expect(finalApproval).toHaveAttribute('aria-disabled', 'true');
    await row(review, pan)
      .getByRole('button', { name: `Reject ${pan}` })
      .click();
    const reject = review.getByRole('dialog', { name: `Reject ${pan}?` });
    const reason = 'Please upload a legible PAN certificate.';
    await reject.getByRole('button', { name: 'Reject document' }).click();
    await expect(reject).toBeVisible();
    await reject.getByLabel('Rejection reason').fill(reason);
    await reject.getByRole('button', { name: 'Reject document' }).click();
    await expect(row(review, pan)).toContainText(reason);
    await create.reload();
    await expect(row(create, pan)).toContainText(reason);
    await expect(row(create, pan).getByRole('button', { name: `Change ${pan}` })).toHaveCount(0);
    await review.getByRole('button', { name: 'Reject', exact: true }).click();
    const returned = review.getByRole('dialog', { name: 'Reject this case?' });
    await returned
      .getByLabel('Reason', { exact: true })
      .fill('Replace the PAN certificate and resubmit.');
    await returned.getByRole('button', { name: 'Reject case' }).click();
    await expect(review.getByText('This case was rejected.')).toBeVisible();
    await create.reload();
    const replacement = await saveUpload(create, pan, 'replacement.png', true);
    expect(replacement).toMatch(/\/versions\/[^/]+\/preview$/);
    expect(replacement).not.toBe(firstPreview);
    await submit(create);
    await review.reload({ waitUntil: 'domcontentloaded' });
    await row(review, pan)
      .getByRole('button', { name: `View ${pan}` })
      .click();
    const preview = review.getByRole('dialog', { name: 'replacement.png' });
    await expect(preview.getByRole('img', { name: 'replacement.png' })).toHaveAttribute(
      'src',
      replacement!,
    );
    await review.keyboard.press('Escape');
    for (const label of labels) {
      await expect(finalApproval).toHaveAttribute('aria-disabled', 'true');
      const item = row(review, label);
      await item.getByRole('button', { name: `Approve ${label}` }).click();
      await expect(item.getByText('Accepted', { exact: true })).toBeVisible();
    }
    await finalApproval.click();
    const approval = review.getByRole('dialog', { name: 'Approve this customer?' });
    await approval.getByLabel('Reason', { exact: true }).fill('Reviewed each current document.');
    await approval.getByRole('button', { name: 'Approve customer', exact: true }).click();
    await expect(review.getByText('This customer is verified.')).toBeVisible();
    await create.reload();
    await expect(create.getByText('This customer is verified.')).toBeVisible();
    await expect(create.getByText(reason, { exact: true })).toBeVisible();
  } finally {
    await Promise.all(opened.map(({ context }) => context.close()));
  }
});
