declare global {
  namespace App {}

  interface HTMLMediaElement {
    setSinkId?(sinkId: string): Promise<void>;
  }
}

export {};
