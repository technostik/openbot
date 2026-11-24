import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "hello-world",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: () => <text fg={context.theme.text.base}>Hello world</text>,
    })
  },
})
