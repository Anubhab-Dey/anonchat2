export function mediaStream(node: HTMLMediaElement, stream: MediaStream | null) {
  node.srcObject = stream;
  return {
    update(next: MediaStream | null) {
      node.srcObject = next;
    },
    destroy() {
      node.srcObject = null;
    }
  };
}
