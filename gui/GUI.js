import './core/GuiEvents';
import './ProfileSettings';
import './ThemeSettings';
import { OverlayManager } from './OverlayUtils';

OverlayManager.editorOrder = OverlayManager.editorOrder.filter((target) => target !== 'music');
