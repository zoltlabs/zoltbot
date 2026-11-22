import { Redirect } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { useCloud } from "../../state/cloud";
import { useLink } from "../../state/link";
import { Drawer } from "../../ui/Drawer";
import { TabBar } from "../../ui/TabBar";

export default function TabsLayout() {
  const client = useLink((state) => state.client);
  const checked = useCloud((state) => state.checked);
  const signedIn = useCloud((state) => state.account.signedIn);
  if (!client && !checked) return null;
  if (!client) return <Redirect href={signedIn ? "/cloud-needs-you" : "/pair"} />;
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
