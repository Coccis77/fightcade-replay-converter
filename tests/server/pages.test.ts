import { describe, expect, it } from 'vitest';
import { ADMIN_PAGE } from '../../src/server/adminPage.js';
import { PAGE } from '../../src/server/page.js';

const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

describe('pages', () => {
  it('main page: valid script, the texts of every state, no browser dialogs', () => {
    for (const s of scripts(PAGE)) expect(() => new Function(s)).not.toThrow();
    for (const t of ['Not set up yet', 'Log in', 'Choose your password', 'replays left today', 'Uploaded by', 'Everyone', 'Log out', 'Download', 'Confirm?']) expect(PAGE).toContain(t);
    expect(PAGE).not.toMatch(/\b(alert|confirm|prompt)\(/);
  });

  it('main page: one list refresh timer, stopped when the page leaves the converter (no wiped login form)', () => {
    expect(PAGE).toContain('clearInterval(listTimer)');
    expect(PAGE).toMatch(/listTimer = setInterval\(loadList, 5000\)/);
  });

  it('main page: anyone can change their password; admin page: asks the admin to choose one when needed', () => {
    expect(PAGE).toContain('Change password');
    expect(ADMIN_PAGE).toContain('Choose your password');
  });

  it('admin page: valid script, setup, login, users and the add form', () => {
    expect(scripts(ADMIN_PAGE).length).toBe(1);
    for (const s of scripts(ADMIN_PAGE)) expect(() => new Function(s)).not.toThrow();
    for (const t of ['Create the admin account', 'Admin login', 'Users', 'Add user', 'Daily limit', 'Reset password', 'Disable', 'Delete', 'This page is for the admin', 'Open the converter']) expect(ADMIN_PAGE).toContain(t);
    expect(ADMIN_PAGE).not.toMatch(/\b(alert|confirm|prompt)\(/);
  });
});
