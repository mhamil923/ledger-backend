import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

interface MutableReadline extends Interface {
  _writeToOutput?: (s: string) => void;
}

export async function promptPassword(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout }) as MutableReadline;
  let muted = false;
  rl._writeToOutput = (s: string): void => {
    if (!muted || s === question || s.includes('\n') || s.includes('\r')) {
      stdout.write(s);
    } else {
      stdout.write('');
    }
  };
  try {
    const pending = rl.question(question);
    muted = true;
    const answer = await pending;
    muted = false;
    stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}
