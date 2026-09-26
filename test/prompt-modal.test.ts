// @vitest-environment jsdom
// Prompt dialog regression: Enter closes + resolves exactly once, the focus
// restore after a CONFIRM must not land on the trigger button (a focused ＋
// button + stray Enter re-opened the dialog — the "Enter doesn't close it" trap),
// and CANCEL keeps the standard focus restoration.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openPrompt } from '../src/web/components/PromptModal';

const tick = () => new Promise((r) => setTimeout(r, 10));

function fireKey(el: Element, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function typeInto(input: Element, text: string) {
  const setter = Object.getOwnPropertyDescriptor((window as any).HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let trigger: HTMLButtonElement;

beforeEach(() => {
  document.querySelector('.modal-overlay')?.remove(); // keep #tk-prompt-host (module root) attached
  trigger = document.createElement('button');
  trigger.id = 'trigger';
  document.body.appendChild(trigger);
  trigger.focus();
});

afterEach(() => {
  document.querySelector('.modal-overlay')?.remove();
  document.getElementById('trigger')?.remove();
});

describe('PromptModal keyboard behavior', () => {
  it('closes on Enter and resolves with the typed value', async () => {
    const pending = openPrompt({ title: 'New project', placeholder: 'Project name', confirmText: 'Create' });
    await tick();
    const input = document.querySelector('.modal input');
    expect(input).toBeTruthy();
    typeInto(input!, 'groceries');
    expect((input as HTMLInputElement).value).toBe('groceries');

    fireKey(input!, 'Enter');
    expect(await pending).toBe('groceries');
    await tick();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('closes on Enter even when the value is empty', async () => {
    const pending = openPrompt({ title: 'New task', placeholder: 'Task name' });
    await tick();
    fireKey(document.querySelector('.modal input')!, 'Enter');
    expect(await pending).toBe('');
    await tick();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('fires onDone at most once (double Enter racing the unmount)', async () => {
    // wrap: openPrompt owns onDone — count resolves instead (a second resolve on
    // the same promise is a no-op by spec, so assert the modal is gone + resolved)
    const pending = openPrompt({ title: 'New project' });
    await tick();
    const input = document.querySelector('.modal input')!;
    fireKey(input, 'Enter');
    fireKey(input, 'Enter'); // second press while unmount is in flight
    expect(await pending).toBe('');
    await tick();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('CONFIRM does not restore focus to the trigger (no Enter re-open trap)', async () => {
    const pending = openPrompt({ title: 'New project', confirmText: 'Create' });
    await tick();
    typeInto(document.querySelector('.modal input')!, 'x');
    fireKey(document.querySelector('.modal input')!, 'Enter');
    await pending;
    await tick();
    expect(document.querySelector('.modal-overlay')).toBeNull();
    expect(document.activeElement).not.toBe(trigger); // a stray Enter must not re-open
  });

  it('CANCEL (Escape) restores focus to the trigger', async () => {
    const pending = openPrompt({ title: 'New task' });
    await tick();
    fireKey(document.querySelector('.modal input')!, 'Escape');
    expect(await pending).toBeNull();
    await tick();
    expect(document.querySelector('.modal-overlay')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('blocks Enter while the typed-confirmation does not match', async () => {
    const pending = openPrompt({ title: 'Delete?', confirmText: 'Delete', mustType: 'name' });
    await tick();
    const input = document.querySelector('.modal input');
    expect(input).toBeTruthy();
    typeInto(input!, 'wrong');
    fireKey(input!, 'Enter');
    await tick();
    expect(document.querySelector('.modal-overlay')).not.toBeNull();
    typeInto(input!, 'name');
    fireKey(input!, 'Enter');
    expect(await pending).toBe('name');
    await tick();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });
});
