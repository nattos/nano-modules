/* Minimal FreeType module set for the text engine: TrueType (glyf) + CFF/
 * PostScript outline loading (sfnt + psnames + psaux + pshinter support). No
 * Type1/autofitter/renderers — we load glyph outlines with FT_LOAD_NO_SCALE and
 * feed them to msdfgen ourselves. CFF is needed so OpenType-CFF fonts (many OS
 * CJK faces, Noto Sans CJK .otf) open as primary or fallback faces. */
FT_USE_MODULE( FT_Driver_ClassRec, tt_driver_class )
FT_USE_MODULE( FT_Driver_ClassRec, cff_driver_class )
FT_USE_MODULE( FT_Module_Class,    sfnt_module_class )
FT_USE_MODULE( FT_Module_Class,    psnames_module_class )
FT_USE_MODULE( FT_Module_Class,    psaux_module_class )
FT_USE_MODULE( FT_Module_Class,    pshinter_module_class )
