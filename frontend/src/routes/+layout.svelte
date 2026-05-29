<script lang="ts">
  import { browser } from "$app/environment";
  import "$lib/styles/app.css";

  if (browser && "serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
</script>

<slot />
