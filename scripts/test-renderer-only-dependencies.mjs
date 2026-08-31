import assert from "node:assert/strict";
import { importsPackage } from "./check-renderer-only-dependencies.mjs";

assert.equal(importsPackage('import value from "react-' + 'markdown";', "react-markdown"), true);
assert.equal(importsPackage('import { Avatar } from "@base-ui/' + 'react/avatar";', "@base-ui/react"), true);
assert.equal(importsPackage('import { Avatar } from "@dicebear/' + 'core";', "@dicebear/core"), true);
assert.equal(importsPackage('import style from "@dicebear/' + 'styles/notionists.json";', "@dicebear/styles"), true);
assert.equal(importsPackage('import Avvvatars from "avvvatars-' + 'react";', "avvvatars-react"), true);
assert.equal(importsPackage('import("@milkdown/' + 'kit/core")', "@milkdown/kit"), true);
assert.equal(importsPackage('import { QRCodeSVG } from "@rc-component/' + 'qrcode";', "@rc-component/qrcode"), true);
assert.equal(importsPackage('const value = require("remark-' + 'gfm")', "remark-gfm"), true);
assert.equal(importsPackage("// react-markdown is rendered only in web", "react-markdown"), false);
assert.equal(importsPackage('import value from "react-' + 'markdown-extra";', "react-markdown"), false);

console.log("renderer-only dependency import boundary tests passed");
