/**
 * PPTX 生成器：确定性、无依赖沙箱，JSZip 手写最小 OOXML 包。
 * 结构：标题页 + 内容页（标题 + 要点列表）。所有文本经 XML 转义。
 */

import JSZip from "jszip";
import { escapeXml, filenameSlug, parseDeck } from "./prompt";
import type { Deck } from "./prompt";
import type { GeneratorInput, GeneratorOutput } from "./types";

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

const REL_OFFICE_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_CORE_PROPS = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const REL_EXT_PROPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";
const REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_SLIDE_MASTER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const REL_SLIDE_LAYOUT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const REL_THEME = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme";

const MIME_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const CLR_MAP_OVR = `<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>`;

function contentTypesXml(slideCount: number): string {
  const slideOverrides = Array.from(
    { length: slideCount },
    (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Types xmlns="${NS_CT}">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    slideOverrides,
    "</Types>",
  ].join("");
}

function rootRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Relationships xmlns="${NS_REL}">`,
    `<Relationship Id="rId1" Type="${REL_OFFICE_DOC}" Target="ppt/presentation.xml"/>`,
    `<Relationship Id="rId2" Type="${REL_CORE_PROPS}" Target="docProps/core.xml"/>`,
    `<Relationship Id="rId3" Type="${REL_EXT_PROPS}" Target="docProps/app.xml"/>`,
    "</Relationships>",
  ].join("");
}

function corePropsXml(title: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapeXml(title)}</dc:title>`,
    "<dc:creator>Go AI</dc:creator>",
    "<cp:lastModifiedBy>Go AI</cp:lastModifiedBy>",
    "</cp:coreProperties>",
  ].join("");
}

function appPropsXml(slideCount: number): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">',
    "<Application>Go AI</Application>",
    `<Slides>${slideCount}</Slides>`,
    "</Properties>",
  ].join("");
}

function presentationXml(slideCount: number): string {
  const sldIds = Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`
  ).join("");
  const levels = Array.from({ length: 9 }, (_, i) => {
    const sz = 2800 - i * 150;
    const align = i === 0 ? ' algn="l"' : ' algn="l"';
    return `<a:lvl${i + 1}pPr${align}><a:defRPr lang="zh-CN" sz="${sz}"/></a:lvl${i + 1}pPr>`;
  }).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">`,
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>',
    `<p:sldIdLst>${sldIds}</p:sldIdLst>`,
    '<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>',
    '<p:notesSz cx="6858000" cy="9144000"/>',
    `<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN" sz="1800"/></a:defPPr>${levels}</p:defaultTextStyle>`,
    "</p:presentation>",
  ].join("");
}

function presentationRelsXml(slideCount: number): string {
  const slideRels = Array.from(
    { length: slideCount },
    (_, i) => `<Relationship Id="rId${i + 2}" Type="${REL_SLIDE}" Target="slides/slide${i + 1}.xml"/>`
  ).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Relationships xmlns="${NS_REL}">`,
    `<Relationship Id="rId1" Type="${REL_SLIDE_MASTER}" Target="slideMasters/slideMaster1.xml"/>`,
    slideRels,
    "</Relationships>",
  ].join("");
}

function slideMasterXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">`,
    "<p:cSld>",
    "<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>",
    "<p:spTree>",
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>',
    "</p:spTree>",
    "</p:cSld>",
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>',
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>',
    "<p:txStyles>",
    '<p:titleStyle><a:lvl1pPr><a:defRPr lang="zh-CN" sz="4400"/></a:lvl1pPr></p:titleStyle>',
    '<p:bodyStyle><a:lvl1pPr><a:defRPr lang="zh-CN" sz="2000"/></a:lvl1pPr></p:bodyStyle>',
    '<p:otherStyle><a:lvl1pPr><a:defRPr lang="zh-CN" sz="1800"/></a:lvl1pPr></p:otherStyle>',
    "</p:txStyles>",
    "</p:sldMaster>",
  ].join("");
}

function slideMasterRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Relationships xmlns="${NS_REL}">`,
    `<Relationship Id="rId1" Type="${REL_THEME}" Target="../theme/theme1.xml"/>`,
    "</Relationships>",
  ].join("");
}

function slideLayoutXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="obj" preserve="1">`,
    "<p:cSld>",
    "<p:spTree>",
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>',
    "</p:spTree>",
    "</p:cSld>",
    CLR_MAP_OVR,
    "</p:sldLayout>",
  ].join("");
}

function slideLayoutRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Relationships xmlns="${NS_REL}">`,
    `<Relationship Id="rId1" Type="${REL_SLIDE_MASTER}" Target="../slideMasters/slideMaster1.xml"/>`,
    `<Relationship Id="rId2" Type="${REL_THEME}" Target="../theme/theme1.xml"/>`,
    "</Relationships>",
  ].join("");
}

function themeXml(): string {
  const fill = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>";
  const line = (w: string) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/></a:ln>`;
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<a:theme xmlns:a="${NS_A}" name="Go AI">`,
    "<a:themeElements>",
    '<a:clrScheme name="Go AI">',
    '<a:dk1><a:srgbClr val="1F1F1F"/></a:dk1>',
    '<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>',
    '<a:dk2><a:srgbClr val="2E5C8A"/></a:dk2>',
    '<a:lt2><a:srgbClr val="EAF1F8"/></a:lt2>',
    '<a:accent1><a:srgbClr val="2E5C8A"/></a:accent1>',
    '<a:accent2><a:srgbClr val="E67E22"/></a:accent2>',
    '<a:accent3><a:srgbClr val="27AE60"/></a:accent3>',
    '<a:accent4><a:srgbClr val="8E44AD"/></a:accent4>',
    '<a:accent5><a:srgbClr val="2980B9"/></a:accent5>',
    '<a:accent6><a:srgbClr val="C0392B"/></a:accent6>',
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>',
    '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>',
    "</a:clrScheme>",
    '<a:fontScheme name="Go AI">',
    '<a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:majorFont>',
    '<a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:minorFont>',
    "</a:fontScheme>",
    '<a:fmtScheme name="Go AI">',
    `<a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>`,
    `<a:lnStyleLst>${line("6350")}${line("12700")}${line("19050")}</a:lnStyleLst>`,
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>',
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst>`,
    "</a:fmtScheme>",
    "</a:themeElements>",
    "</a:theme>",
  ].join("");
}

function slideRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Relationships xmlns="${NS_REL}">`,
    `<Relationship Id="rId1" Type="${REL_SLIDE_LAYOUT}" Target="../slideLayouts/slideLayout1.xml"/>`,
    "</Relationships>",
  ].join("");
}

function titleSlideXml(title: string, subtitle: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">`,
    "<p:cSld>",
    "<p:spTree>",
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>',
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>',
    '<p:spPr><a:xfrm><a:off x="685800" y="2743200"/><a:ext cx="7772400" cy="1371600"/></a:xfrm></p:spPr>',
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="5400" b="1"/><a:t>' + escapeXml(title) + "</a:t></a:r></a:p></p:txBody></p:sp>",
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>',
    '<p:spPr><a:xfrm><a:off x="685800" y="4114800"/><a:ext cx="7772400" cy="914400"/></a:xfrm></p:spPr>',
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2800"/><a:t>' + escapeXml(subtitle) + "</a:t></a:r></a:p></p:txBody></p:sp>",
    "</p:spTree>",
    "</p:cSld>",
    CLR_MAP_OVR,
    "</p:sld>",
  ].join("");
}

function contentSlideXml(slideTitle: string, bullets: string[]): string {
  const safeBullets = bullets.length ? bullets : ["（待补充具体内容）"];
  const bulletParagraphs = safeBullets
    .map((b) => `<a:p><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>• ${escapeXml(b)}</a:t></a:r></a:p>`)
    .join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">`,
    "<p:cSld>",
    "<p:spTree>",
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>',
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>',
    '<p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="914400"/></a:xfrm></p:spPr>',
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="4000" b="1"/><a:t>' + escapeXml(slideTitle) + "</a:t></a:r></a:p></p:txBody></p:sp>",
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>',
    '<p:spPr><a:xfrm><a:off x="457200" y="1371600"/><a:ext cx="8229600" cy="5029200"/></a:xfrm></p:spPr>',
    `<p:txBody><a:bodyPr/><a:lstStyle/>${bulletParagraphs}</p:txBody></p:sp>`,
    "</p:spTree>",
    "</p:cSld>",
    CLR_MAP_OVR,
    "</p:sld>",
  ].join("");
}

export async function generatePptx({ message }: GeneratorInput): Promise<GeneratorOutput> {
  const deck: Deck = parseDeck(message);
  const slides = deck.slides.map((s) => ({ title: s.title, bullets: s.bullets }));
  const slideCount = slides.length + 1; // 标题页 + 内容页

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml(slideCount));
  zip.file("_rels/.rels", rootRelsXml());
  zip.file("docProps/core.xml", corePropsXml(deck.title));
  zip.file("docProps/app.xml", appPropsXml(slideCount));
  zip.file("ppt/presentation.xml", presentationXml(slideCount));
  zip.file("ppt/_rels/presentation.xml.rels", presentationRelsXml(slideCount));
  zip.file("ppt/slideMasters/slideMaster1.xml", slideMasterXml());
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", slideMasterRelsXml());
  zip.file("ppt/slideLayouts/slideLayout1.xml", slideLayoutXml());
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", slideLayoutRelsXml());
  zip.file("ppt/theme/theme1.xml", themeXml());
  zip.file("ppt/slides/slide1.xml", titleSlideXml(deck.title, deck.subtitle));
  zip.file("ppt/slides/_rels/slide1.xml.rels", slideRelsXml());
  slides.forEach((s, i) => {
    const n = i + 2;
    zip.file(`ppt/slides/slide${n}.xml`, contentSlideXml(s.title, s.bullets));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, slideRelsXml());
  });

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", mimeType: MIME_PPTX });
  return { filename: `${filenameSlug(deck.title, "演示文稿")}.pptx`, mime: MIME_PPTX, kind: "pptx", content };
}
