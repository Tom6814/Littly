import { Navigate, Route, Routes } from 'react-router';
import RequireAuth from './components/RequireAuth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ChatPage from './pages/ChatPage';
import DashboardPage from './pages/console/DashboardPage';
import CharactersPage from './pages/console/CharactersPage';
import WorldbookPage from './pages/console/WorldbookPage';
import GrowthPage from './pages/console/GrowthPage';
import ContactsPage from './pages/console/ContactsPage';
import MemoriesPage from './pages/console/MemoriesPage';
import DiaryPage from './pages/console/DiaryPage';
import AlbumPage from './pages/console/AlbumPage';
import ScheduledPage from './pages/console/ScheduledPage';
import RulesPage from './pages/console/RulesPage';
import SettingsBotPage from './pages/console/SettingsBotPage';
import SettingsGlobalPage from './pages/console/SettingsGlobalPage';
import PluginsPage from './pages/console/PluginsPage';
import BiliPage from './pages/console/BiliPage';
import BindPage from './pages/console/BindPage';
import DebugPage from './pages/console/DebugPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/console" element={<Navigate to="/console/dashboard" replace />} />
          <Route path="/console/dashboard" element={<DashboardPage />} />
          <Route path="/console/characters" element={<CharactersPage />} />
          <Route path="/console/worldbook" element={<WorldbookPage />} />
          <Route path="/console/growth" element={<GrowthPage />} />
          <Route path="/console/contacts" element={<ContactsPage />} />
          <Route path="/console/memories" element={<MemoriesPage />} />
          <Route path="/console/diary" element={<DiaryPage />} />
          <Route path="/console/album" element={<AlbumPage />} />
          <Route path="/console/scheduled" element={<ScheduledPage />} />
          <Route path="/console/rules" element={<RulesPage />} />
          <Route path="/console/settings-bot" element={<SettingsBotPage />} />
          <Route path="/console/settings-global" element={<SettingsGlobalPage />} />
          <Route path="/console/plugins" element={<PluginsPage />} />
          <Route path="/console/bind" element={<BindPage />} />
          <Route path="/console/bili" element={<BiliPage />} />
          <Route path="/console/debug" element={<DebugPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
