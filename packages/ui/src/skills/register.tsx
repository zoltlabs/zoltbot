import { registerContextSection } from "../context/SessionInputsPanel.js";
import { TaskSkillsContextSection } from "./TaskSkillsContextSection.js";

registerContextSection({
  id: "2-skills",
  title: "Skills",
  render: (props) => <TaskSkillsContextSection {...props} />,
});
