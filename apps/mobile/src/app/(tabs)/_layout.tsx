import { Redirect } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { useLink } from "../../state/link";
import { Drawer } from "../../ui/Drawer";
import { TabBar } from "../../ui/TabBar";

export default function TabsLayout() {
  const client = useLink((state) => state.client);
  if (!client) return <Redirect href="/pair" />;
  return (
    <>
      <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} />}>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="tasks" />
        <Tabs.Screen name="compose" />
        <Tabs.Screen name="activity" />
        <Tabs.Screen name="settings" />
      </Tabs>
      <Drawer />
    </>
  );
}
