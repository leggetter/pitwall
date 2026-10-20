// Buttons, alerts, key caps and the app strip (W24): the real Button, Alert, KeyCaps and AppStrip in
// each variant and state. The page alerts in their place, at the top of the session list, are in
// Page states; the message box's alerts are in Message box.

import { AppStrip } from '../components/AppStrip.js';
import { Alert, Detail } from '../components/Alert.js';
import { Button, type ButtonVariant } from '../components/Button.js';
import { KeyCaps, modEnter } from '../components/KeyCaps.js';
import { Spinner } from '../components/Spinner.js';
import { relayAlertText } from '../relay.js';
import { RELAY_ALERT_BLOCKED, RELAY_ALERT_OFF, RELAY_OFF } from './fixtures.js';
import { Specimen } from './kit.js';

const noop = () => {};

const VARIANTS: { variant: ButtonVariant; label: string; busy: string; icon?: 'send' | 'stop' | 'add' }[] = [
  { variant: 'primary', label: 'Send', busy: 'Sending…', icon: 'send' },
  { variant: 'outline', label: 'Load earlier', busy: 'Loading earlier…' },
  { variant: 'ghost', label: 'Dismiss', busy: 'Dismissing…' },
  { variant: 'danger', label: 'Stop session', busy: 'Stopping…', icon: 'stop' },
];

export function Buttons() {
  return (
    <>
      <Specimen
        title="Variants and states"
        note='Idle, disabled (aria-disabled: still focusable, and Tab reaches it; activating it does nothing) and busy (a spinner after half a second, the -ing label, aria-busy, the idle width kept). Disabled text is --pw-text-disabled, the one contrast exemption.'
      >
        <table className="uikit-table uikit-buttons">
          <thead>
            <tr>
              <th scope="col">Variant</th>
              <th scope="col">Idle</th>
              <th scope="col">Disabled</th>
              <th scope="col">Busy</th>
            </tr>
          </thead>
          <tbody>
            {VARIANTS.map(({ variant, label, busy, icon }) => (
              <tr key={variant}>
                <th scope="row">{variant}</th>
                <td>
                  <Button variant={variant} icon={icon} onClick={noop}>
                    {label}
                  </Button>
                </td>
                <td>
                  <Button variant={variant} icon={icon} disabled onClick={noop}>
                    {label}
                  </Button>
                </td>
                <td>
                  <Button variant={variant} icon={icon} busy busyLabel={busy} onClick={noop}>
                    {label}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Specimen>
      <Specimen title="Sizes" note="sm 24 px, md 28 px (the default), lg 32 px.">
        <p className="uikit-row">
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <Button key={size} size={size} onClick={noop}>
              Clear filters
            </Button>
          ))}
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <Button key={`disabled-${size}`} size={size} disabled onClick={noop}>
              Clear filters
            </Button>
          ))}
        </p>
      </Specimen>
      <Specimen title="Spinners" note="12 px inline, in --pw-info-fg; 16 px in a button, in its text colour. Each waits half a second before it shows.">
        <p className="uikit-row">
          <Spinner />
          <Spinner size="button" />
        </p>
      </Specimen>
      <Specimen title="Key caps" note="⌘ on Apple platforms, Ctrl elsewhere; the caps are hidden from screen readers, which read the words.">
        <p className="uikit-row">
          <KeyCaps {...modEnter(true)} />
          <KeyCaps {...modEnter(false)} />
          <KeyCaps keys={['Esc']} label="Escape" />
          <KeyCaps keys={['/']} label="Slash" />
        </p>
      </Specimen>
    </>
  );
}

const blocked = relayAlertText(RELAY_ALERT_BLOCKED);
const sent = relayAlertText(RELAY_ALERT_OFF);
const off = relayAlertText(RELAY_ALERT_OFF, RELAY_OFF);

/** Each tone, as the page alerts use them, and one with an action, standalone and at 375 px. */
function AlertSet() {
  return (
    <div className="uikit-stack">
      <Alert tone="warning" title="Couldn't list sessions">
        <code>claude agents --json --all</code> failed on the latest poll: <Detail>claude exited with code 1: pitwall-test made-up failure</Detail>
      </Alert>
      <Alert tone="danger" onDismiss={noop}>
        The index couldn&apos;t read one transcript: a made-up error for pitwall-test.
      </Alert>
      <Alert tone="danger" title={sent.title} onDismiss={noop}>
        {sent.summary} {sent.count} Latest: <Detail>{RELAY_ALERT_OFF.detail}</Detail>
      </Alert>
      <Alert tone="warning" title={blocked.title} onDismiss={noop}>
        {blocked.summary} {blocked.count} Latest: <Detail>{RELAY_ALERT_BLOCKED.detail}</Detail>
      </Alert>
      <Alert tone="neutral" onDismiss={noop}>
        Started pitwall-test-started. Its view opens when it shows up in the list.
      </Alert>
      <Alert tone="neutral">Lost the connection to pitwall. Reconnecting; this list may be out of date.</Alert>
      <Alert tone="success">Stopped. Its conversation is kept.</Alert>
      <Alert
        tone="info"
        title="An info alert with an action"
        actions={
          <Button size="sm" onClick={noop}>
            Try again
          </Button>
        }
        onDismiss={noop}
      >
        Actions are outline sm buttons at the right, and wrap under the text at 600 px and narrower.
      </Alert>
    </div>
  );
}

export function Alerts() {
  return (
    <>
      <Specimen
        title="Inline alerts"
        note="Each page alert, and the other tones. The icon is the tint's -tint-fg and the text --pw-text; Dismiss is a ghost sm button, whose --pw-text-muted passes on every tint."
      >
        <AlertSet />
      </Specimen>
      <Specimen title="Inline alerts at 375 px" note="The actions wrap under the text." width={375}>
        <div className="uikit-window-pad">
          <AlertSet />
        </div>
      </Specimen>
      <Specimen
        title="The relay alert while messaging is off"
        note="The snapshot's relayOff is set, so the alert says so too. Without it, a relay alert never says messaging is off."
      >
        <Alert tone="danger" title={off.title} onDismiss={noop}>
          {off.summary} {off.count} Latest: <Detail>{RELAY_ALERT_OFF.detail}</Detail>
        </Alert>
      </Specimen>
      <Specimen
        title="App strip"
        note="Only while the snapshot's relayOff is set: messaging is off until pitwall restarts. It inverts with the theme, stays when the alert is dismissed, and can't be dismissed itself. Details reopens the relay alert."
      >
        <AppStrip off={RELAY_OFF} onDetails={noop} />
      </Specimen>
      <Specimen title="App strip at 375 px" note="One line, 32 px: the sentence ends in an ellipsis, with the whole of it in the hover text, and Details stays." width={375}>
        <AppStrip off={RELAY_OFF} onDetails={noop} />
      </Specimen>
    </>
  );
}
