import {
  APP_FONT_SIZE_STEP_PX,
  changeAppFontSizePx,
} from '../lib/appFontSizePreference';
import { useShortcut } from './useShortcut';

export function useAppFontSizeHotkeys() {
  useShortcut('app.font-size.increase', () => {
    changeAppFontSizePx(APP_FONT_SIZE_STEP_PX);
  });

  useShortcut('app.font-size.decrease', () => {
    changeAppFontSizePx(-APP_FONT_SIZE_STEP_PX);
  });
}
