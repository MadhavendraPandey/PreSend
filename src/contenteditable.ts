export function replaceContentEditableText(composer: HTMLElement, text: string): void {
  composer.focus();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);

  // Browser editing commands remain the most compatible way to keep rich-text
  // editor state in sync. The direct DOM fallback still notifies the host app.
  const inserted = document.execCommand?.('insertText', false, text) ?? false;
  if (!inserted) {
    composer.replaceChildren(document.createTextNode(text));
    composer.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
  }

  selection?.removeAllRanges();
}
