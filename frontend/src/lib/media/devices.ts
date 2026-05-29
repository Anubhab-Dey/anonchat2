export type DeviceLists = {
  microphones: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
};

export async function listDevices(): Promise<DeviceLists> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { microphones: [], cameras: [], speakers: [] };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    microphones: devices.filter((device) => device.kind === "audioinput"),
    cameras: devices.filter((device) => device.kind === "videoinput"),
    speakers: devices.filter((device) => device.kind === "audiooutput")
  };
}

export async function getCallStream(cameraDeviceId = "", microphoneDeviceId = "") {
  const audio: MediaTrackConstraints | boolean = microphoneDeviceId ? { deviceId: { exact: microphoneDeviceId } } : true;
  const video: MediaTrackConstraints | boolean = cameraDeviceId
    ? { deviceId: { exact: cameraDeviceId }, width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 } }
    : { width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 } };

  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch (error) {
    if (cameraDeviceId) {
      throw error;
    }
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
  }
}
