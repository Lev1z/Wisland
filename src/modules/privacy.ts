import { listen } from "@tauri-apps/api/event";
import type { PrivacyUsagePayload } from "../types";
import { capsule, privacyIndicators, privacyMic, privacyCamera } from "../dom";
import {
  privacyPopupTimer, setPrivacyPopupTimer,
  privacyPulseCleanupTimer, setPrivacyPulseCleanupTimer,
  lastPrivacyUsage, setLastPrivacyUsage,
} from "../state";

export function hidePrivacyPopup() {

  if (privacyPopupTimer) {

    clearTimeout(privacyPopupTimer);

    setPrivacyPopupTimer(null);

  }

  if (privacyPulseCleanupTimer) {

    clearTimeout(privacyPulseCleanupTimer);

    setPrivacyPulseCleanupTimer(null);

  }

  capsule.classList.remove("privacy-active", "privacy-pulse");

  privacyIndicators.classList.remove("active", "pulse");

  privacyMic.classList.remove("active");

  privacyCamera.classList.remove("active");

}



function showPrivacyPopup(payload: PrivacyUsagePayload) {

  const { microphone, camera } = payload;

  if (!microphone && !camera) return;



  privacyMic.classList.toggle("active", microphone);

  privacyCamera.classList.toggle("active", camera);



  capsule.classList.add("privacy-active");

  capsule.classList.remove("privacy-pulse");

  void capsule.offsetWidth;

  capsule.classList.add("privacy-pulse");

  if (privacyPulseCleanupTimer) {

    clearTimeout(privacyPulseCleanupTimer);

  }

  setPrivacyPulseCleanupTimer(window.setTimeout(() => {

    capsule.classList.remove("privacy-pulse");

    setPrivacyPulseCleanupTimer(null);

  }, 460));



  privacyIndicators.classList.remove("pulse");

  void privacyIndicators.offsetWidth;

  privacyIndicators.classList.add("active", "pulse");



  if (privacyPopupTimer) {

    clearTimeout(privacyPopupTimer);

  }

  setPrivacyPopupTimer(window.setTimeout(() => {

    hidePrivacyPopup();

  }, 3000));

}



export function initPrivacy() {

  listen<PrivacyUsagePayload>("privacy-usage", (event) => {

    const next = event.payload;

    const micStarted = next.microphone && !lastPrivacyUsage.microphone;

    const camStarted = next.camera && !lastPrivacyUsage.camera;



    if (micStarted || camStarted) {

      showPrivacyPopup(next);

    } else if (!next.microphone && !next.camera && (lastPrivacyUsage.microphone || lastPrivacyUsage.camera)) {

      // 麦克风和摄像头都停止使用，主动收起隐私弹窗

      hidePrivacyPopup();

    }



    setLastPrivacyUsage(next);

  });

}
