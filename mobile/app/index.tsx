import { InboxScreen } from '../src/forca-inbox/InboxScreen'
import { isForcaBuild } from '../src/forca-inbox/is-forca-build'
import { MobileHomeScreen } from '../src/home/MobileHomeScreen'

// Forca: the inbox is the first screen of a Forca build. The host list moves to /hosts.
export default isForcaBuild ? InboxScreen : MobileHomeScreen
