import { expect, test, type Page } from '@playwright/test';

/** Fails the test on any console error or uncaught exception in the page or its worker. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function clock(page: Page): Promise<string> {
  return (await page.getByTestId('clock').textContent()) ?? '';
}

test.beforeEach(async ({ page }) => {
  // Every test starts from the starter scenario, not a previous test's session.
  await page.addInitScript(() => indexedDB.deleteDatabase('distlab'));
});

test('loads the starter scenario and runs it in the browser', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('lab')).toBeVisible();
  for (const id of ['client', 'lb', 'api-1', 'api-2', 'db']) await expect(page.getByTestId(`node-${id}`)).toBeVisible();

  const before = await clock(page);
  await page.getByTestId('play').click();
  await expect.poll(() => clock(page), { timeout: 10_000 }).not.toBe(before);
  await page.waitForTimeout(1200);
  await page.getByTestId('play').click(); // pause

  await expect(page.getByTestId('metrics')).toContainText('Requests');
  const requests = await page.getByTestId('metrics').locator('.stat').first().locator('.stat-value').textContent();
  expect(Number((requests ?? '0').replace(/[^0-9.]/g, ''))).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('steps, steps back and scrubs deterministically', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('node-db')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('.timeline')).toContainText('#5');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.timeline')).toContainText('#4');

  // Scrub to the middle of the run.
  const scrubber = page.getByTestId('scrubber');
  const box = (await scrubber.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => clock(page)).toMatch(/^00:(09|10)\./);
  expect(errors).toEqual([]);
});

test('opens a library scenario and explains a failure from its causes', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Library' }).click();
  await page.getByTestId('scenario-network-partition').click();
  await expect(page.getByTestId('node-api')).toBeVisible();

  await page.keyboard.press('e'); // run to the end
  await expect.poll(() => clock(page)).toMatch(/^00:14\.000/);

  await page.getByTestId('tab-events').click();
  await page.getByRole('button', { name: 'Failures' }).click();
  await expect(page.getByTestId('event-row').first()).toBeVisible();
  await page.getByTestId('event-row').filter({ hasText: 'Request failed' }).first().click();
  await expect(page.getByTestId('inspector')).toContainText('Why');

  await page.getByTestId('tab-explain').click();
  await expect(page.getByTestId('explain')).toContainText('partition');
  await expect(page.getByTestId('explain')).toContainText('measured');
  expect(errors).toEqual([]);
});

test('edits a node and injects a fault interactively', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.getByTestId('node-api-1').click();
  await expect(page.getByTestId('inspector')).toContainText('Configuration');
  const concurrency = page.getByTestId('inspector').getByLabel('Concurrency');
  await concurrency.fill('2');
  await concurrency.press('Enter');
  await page.getByTestId('inspector').getByRole('button', { name: 'Crash now' }).click();
  await expect(page.getByTestId('inspector')).toContainText('Node crash');
  await page.keyboard.press('e');
  await page.getByTestId('tab-metrics').click();
  await expect(page.getByTestId('metrics')).toContainText('Success rate');
  expect(errors).toEqual([]);
});

test('compares two architectures on the same workload', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Compare' }).click();
  await page.getByRole('button', { name: 'Run both' }).click();
  await expect(page.getByTestId('comparison')).toContainText('p99 latency', { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('runs a what-if experiment', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'What-if' }).click();
  await page.getByRole('button', { name: 'Traffic doubles' }).click();
  await page.getByTestId('run-experiment').click();
  await expect(page.getByTestId('comparison')).toContainText('Requests issued', { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('exports the scenario as JSON', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('node-db')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  expect((await download).suggestedFilename()).toBe('distlab-scenario.json');
});
