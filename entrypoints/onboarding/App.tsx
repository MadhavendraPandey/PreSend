import { useState } from 'react';
import { browser } from 'wxt/browser';
import { setOnboardingCompleted } from '../../src/storage';

const screens = [
  {
    title: 'Check before you send',
    body: 'PreSend accesses text you type into supported AI chat composers so it can detect likely sensitive information before submission. It can also read selected supported files locally before upload.',
  },
  {
    title: 'Local by design',
    body: 'Scanning happens in your browser. PreSend does not send prompt content, file content, or detected secrets to its own servers.',
  },
  {
    title: 'You stay in control',
    body: 'When PreSend detects something, you can replace it with a safe example, redact it, send it anyway, or cancel.',
  },
] as const;

export default function App() {
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  const screen = screens[step]!;
  const isLast = step === screens.length - 1;

  const finish = async () => {
    try {
      await setOnboardingCompleted(true);
      await browser.runtime.openOptionsPage();
      window.close();
    } catch {
      setError('PreSend could not save onboarding status. You can retry safely.');
    }
  };

  return (
    <main>
      <img src="/icons/icon-128.png" width="82" height="82" alt="PreSend shield icon" />
      <p className="eyebrow">WELCOME TO PRESEND</p>
      <h1>{screen.title}</h1>
      <p className="body-copy">{screen.body}</p>

      {step === 2 && (
        <ul>
          <li>Replace with Safe Example</li>
          <li>Redact</li>
          <li>Send Anyway</li>
          <li>Cancel</li>
        </ul>
      )}

      <div className="progress" aria-label={`Step ${step + 1} of ${screens.length}`}>
        {screens.map((_, index) => (
          <span key={index} className={index === step ? 'active' : ''} />
        ))}
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        {step > 0 && (
          <button type="button" className="secondary" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <button
          type="button"
          className="primary"
          onClick={() => isLast ? void finish() : setStep(step + 1)}
        >
          {isLast ? 'Get Started' : 'Continue'}
        </button>
      </div>
      <p className="account-note">No account required. No telemetry.</p>
    </main>
  );
}
