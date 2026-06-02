/* Minimal FreeType module set for the text engine: TrueType outline loading
 * only (sfnt + psnames support). No CFF/Type1/autofitter/renderers — we load
 * glyph outlines with FT_LOAD_NO_SCALE and feed them to msdfgen ourselves. */
FT_USE_MODULE( FT_Driver_ClassRec, tt_driver_class )
FT_USE_MODULE( FT_Module_Class,    sfnt_module_class )
FT_USE_MODULE( FT_Module_Class,    psnames_module_class )
