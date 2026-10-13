import { expect, test } from '@playwright/test';

const story = (name: string) => `/iframe.html?id=skills-project-repository-skills-02-journeys--${name}&viewMode=story&globals=theme:dark`;

test('legacy adoption imports directly and survives navigation within the journey', async ({ page }, info) => {
  await page.goto(story('legacy-adoption'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  const action = page.getByRole('button', { name: 'Import skills', exact: true });
  await action.click();
  await expect(source).toBeVisible();
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
  await expect(action).toHaveCount(0);
  await page.getByRole('link', { name: 'Installed skills', exact: true }).click();
  await expect(source).toHaveCount(0);
  await expect(page.getByText('Code review', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Skills', { exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(source).toBeVisible();
  await page.screenshot({ path: info.outputPath('legacy-adopted.png') });
});

test('background refresh imports an addition without clicking refresh', async ({ page }, info) => {
  await page.goto(story('automatic-update'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await expect(source.getByText('Security review', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(source.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('automatic-update.png') });
});

test('refresh failure retains content and retry recovers', async ({ page }, info) => {
  await page.goto(story('failed-refresh'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
  await expect(source.getByRole('alert')).toContainText('installed skills were kept');
  await source.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(source.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await source.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(source.getByText('Security review', { exact: true })).toBeVisible();
  await expect(source.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('refresh-recovered.png') });
});

test('automatic update preference is accessible and changes in place', async ({ page }) => {
  await page.goto(story('synced'));
  await page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true }).click();
  const toggle = page.getByRole('menuitemcheckbox', { name: 'Automatic updates', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(page.getByText('Automatic updates paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'More actions for acme/team-skills', exact: true })).toBeFocused();
});

test('mobile source actions stay usable without horizontal overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story('mobile'));
  await expect(page.getByRole('heading', { name: 'Skill sources', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('sources-mobile.png') });
});

test('connection repair keeps the installed skills and selections', async ({ page }) => {
  await page.goto(story('connection-repair'));
  const source = page.getByRole('region', { name: 'acme/team-skills', exact: true });
  await source.getByRole('button', { name: 'Choose connection', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Save connection', exact: true })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'My GitHub account', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(source.getByRole('button', { name: 'More actions for acme/team-skills', exact: true })).toBeFocused();
  await expect(source.getByRole('alert')).toHaveCount(0);
  await expect(source.getByText('Code review', { exact: true })).toBeVisible();
});
