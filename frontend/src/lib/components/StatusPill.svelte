<script lang="ts">
  export let text = "";
  export let tone: "good" | "warn" | "bad" | "" = "";
</script>

<span class={`pill ${tone}`.trim()}>{text}</span>
